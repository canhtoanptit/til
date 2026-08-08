import type { JSONSchema7, ToolSet, UIMessage } from "ai";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { CHAT_SYSTEM_PROMPT } from "./chat.js";
import { createModel } from "./provider.js";
import type { LLMSettings } from "./types.js";

/** Upper bound on the tool loop: a confused model cannot spin forever. */
export const CHAT_DEFAULT_MAX_STEPS = 6;

export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema (draft-7 shape), e.g. an entry of CHAT_TOOL_SCHEMAS. */
  inputSchema: unknown;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface StreamChatOptions {
  settings: LLMSettings;
  /** Whatever the chat host holds — UIMessage-shaped; converted here. */
  messages: unknown;
  tools: ChatTool[];
  maxSteps?: number;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
}

/**
 * The one place `ai` is allowed to run a chat turn (ADR-0002 guardrail 3).
 * Returns an AI SDK UI-message stream Response, which is what
 * `AIChatAgent.onChatMessage` must hand back.
 */
export async function streamChat(opts: StreamChatOptions): Promise<Response> {
  const maxSteps = clampMaxSteps(opts.maxSteps);
  const result = streamText({
    model: createModel(opts.settings, opts.fetchImpl),
    system: CHAT_SYSTEM_PROMPT,
    messages: await convertToModelMessages(toUIMessages(opts.messages)),
    tools: toToolSet(opts.tools),
    stopWhen: stepCountIs(maxSteps),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
  return result.toUIMessageStreamResponse({ onError: describeChatStreamError });
}

/**
 * Without this the SDK masks every failure as "An error occurred", which hides
 * the one failure users actually hit: models whose tool-calling the provider
 * rejects. Returns prose for the chat bubble — never raw provider payloads,
 * which can echo back the prompt.
 */
export function describeChatStreamError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/failed to call a function|failed_generation|tool.?call/i.test(raw)) {
    return "The model failed to use the search tools. Some models advertise tool calling but emit a format the provider rejects — llama-3.3-70b-versatile on Groq is a known case. Pick a tool-capable model in Settings (on Groq, openai/gpt-oss-20b works) and try again.";
  }
  if (/rate.?limit|429|tokens per (minute|min)|tpm/i.test(raw)) {
    return "The provider rate-limited this request. Wait a moment and try again.";
  }
  if (/unauthorized|401|invalid.?api.?key|forbidden|403/i.test(raw)) {
    return "The provider rejected the credentials. Check the API key and gateway settings in Settings.";
  }
  return `The assistant could not finish that answer: ${raw.slice(0, 300)}`;
}

/**
 * A one-shot assistant turn carrying a fixed message, in the same wire format
 * as `streamChat`. For refusals the user must be able to read (no settings
 * configured), where throwing would surface as an opaque stream error.
 */
export function chatNoticeResponse(text: string): Response {
  const id = "notice";
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start" });
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
        writer.write({ type: "finish" });
      },
    }),
  });
}

function clampMaxSteps(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return CHAT_DEFAULT_MAX_STEPS;
  return Math.max(1, Math.trunc(raw));
}

function toToolSet(tools: ChatTool[]): ToolSet {
  const set: ToolSet = {};
  for (const entry of tools) {
    set[entry.name] = tool({
      description: entry.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        entry.inputSchema as JSONSchema7,
      ),
      execute: (input) => entry.execute(input),
    });
  }
  return set;
}

// WHY: the host (a Durable Object) owns the transcript and its exact generic
// parameters, so it arrives as `unknown` rather than dragging `ai`'s UIMessage
// type across the seam. `convertToModelMessages` ignores `id`.
function toUIMessages(messages: unknown): Omit<UIMessage, "id">[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter(isUIMessageLike);
}

function isUIMessageLike(value: unknown): value is UIMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { role?: unknown; parts?: unknown };
  return typeof candidate.role === "string" && Array.isArray(candidate.parts);
}
