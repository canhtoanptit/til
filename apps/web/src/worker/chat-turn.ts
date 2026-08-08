import { settings as settingsTable } from "@til/db";
import { CHAT_DEFAULT_MAX_STEPS, chatNoticeResponse, streamChat } from "@til/core";
import { chatTitleFrom, toChatMessageDTO } from "./chat-dto.js";
import { indexConversation } from "./chat-index.js";
import { buildChatTools } from "./chat-tools.js";
import type { Deps } from "./deps.js";
import { toLLMSettings } from "./settings.js";

export const CHAT_NO_SETTINGS_NOTICE =
  "I cannot answer yet: no LLM provider is configured. Open Settings, save a provider, model and API key, then ask me again.";

export interface ChatTurnOptions {
  conversationId: string;
  /** The persisted transcript, UIMessage-shaped; converted inside core. */
  messages: unknown;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

/**
 * One chat turn, independent of the Durable Object that hosts it: refresh the
 * conversation index, resolve BYOK settings, bind the read-only tools, and hand
 * the streaming call to core (the only place `ai` may be imported, ADR-0002).
 */
export async function chatTurnResponse(
  deps: Deps,
  opts: ChatTurnOptions,
): Promise<Response> {
  await touchConversation(deps, opts.conversationId, opts.messages);

  const rows = await deps.db.select().from(settingsTable).limit(1);
  const row = rows[0];
  // WHY a notice and not a throw: an unconfigured provider is the user's most
  // likely first experience of chat, and a thrown error reaches them as an
  // opaque stream failure with no instructions.
  if (!row) return chatNoticeResponse(CHAT_NO_SETTINGS_NOTICE);

  return streamChat({
    settings: toLLMSettings(row),
    messages: opts.messages,
    tools: buildChatTools(deps),
    maxSteps: opts.maxSteps ?? CHAT_DEFAULT_MAX_STEPS,
    fetchImpl: deps.fetchImpl,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
}

/** Best-effort: the conversation list must never cost the user their answer. */
export async function touchConversation(
  deps: Deps,
  conversationId: string,
  messages: unknown,
): Promise<void> {
  const list = Array.isArray(messages) ? messages : [];
  try {
    await indexConversation(deps, conversationId, {
      title: firstUserTitle(list),
      messageCount: list.length,
    });
  } catch (err) {
    console.warn(
      "[chat] could not index conversation:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function firstUserTitle(messages: unknown[]): string | null {
  for (const message of messages) {
    const dto = toChatMessageDTO(message, 0);
    if (dto?.role === "user") return chatTitleFrom(dto.content);
  }
  return null;
}
