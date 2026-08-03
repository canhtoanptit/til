import { DigestError } from "./errors.js";
import {
  buildUserMessage,
  DIGEST_JSON_SCHEMA,
  DIGEST_SYSTEM_PROMPT,
  DIGEST_TOOL_DESCRIPTION,
  DIGEST_TOOL_NAME,
  parseDigest,
} from "./prompt.js";
import type { Digest, LLMClient, LLMSettings } from "./types.js";
import { gatewayBaseURL } from "./url.js";

const ANTHROPIC_VERSION = "2023-06-01";

export class DirectLLMClient implements LLMClient {
  private readonly settings: LLMSettings;
  private readonly fetchImpl: typeof fetch;

  constructor(settings: LLMSettings, fetchImpl?: typeof fetch) {
    this.settings = settings;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  async digest(
    markdown: string,
    meta: { url: string; title?: string },
  ): Promise<Digest> {
    const user = buildUserMessage(markdown, meta);
    if (this.settings.provider === "openai") {
      return this.digestOpenAI(user);
    }
    return this.digestAnthropic(user);
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await this.pingRequest();
      if (response.ok) return { ok: true };
      const text = await safeReadText(response);
      return {
        ok: false,
        detail: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
      };
    } catch (err) {
      return { ok: false, detail: describeError(err) };
    }
  }

  private async pingRequest(): Promise<Response> {
    const base = gatewayBaseURL(this.settings);
    if (this.settings.provider === "openai") {
      return this.fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: this.openAIHeaders(),
        body: JSON.stringify({
          model: this.settings.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
    }
    return this.fetchImpl(`${base}/v1/messages`, {
      method: "POST",
      headers: this.anthropicHeaders(),
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
  }

  private async digestOpenAI(user: string): Promise<Digest> {
    const base = gatewayBaseURL(this.settings);
    const response = await this.fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: this.openAIHeaders(),
      body: JSON.stringify({
        model: this.settings.model,
        messages: [
          { role: "system", content: DIGEST_SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "digest",
            strict: true,
            schema: DIGEST_JSON_SCHEMA,
          },
        },
      }),
    });

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new DigestError(
        `OpenAI request failed with HTTP ${response.status}${
          detail ? `: ${detail}` : ""
        }`,
      );
    }

    const body = (await safeReadJson(response)) as unknown;
    const content = extractOpenAIContent(body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new DigestError(
        "OpenAI response content was not valid JSON.",
      );
    }
    return parseDigest(parsed);
  }

  private async digestAnthropic(user: string): Promise<Digest> {
    const base = gatewayBaseURL(this.settings);
    const response = await this.fetchImpl(`${base}/v1/messages`, {
      method: "POST",
      headers: this.anthropicHeaders(),
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: 2048,
        system: DIGEST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
        tools: [
          {
            name: DIGEST_TOOL_NAME,
            description: DIGEST_TOOL_DESCRIPTION,
            input_schema: DIGEST_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: DIGEST_TOOL_NAME },
      }),
    });

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new DigestError(
        `Anthropic request failed with HTTP ${response.status}${
          detail ? `: ${detail}` : ""
        }`,
      );
    }

    const body = (await safeReadJson(response)) as unknown;
    const input = extractAnthropicToolInput(body);
    return parseDigest(input);
  }

  private openAIHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.settings.apiKey}`,
    };
    this.applyAigToken(headers);
    return headers;
  }

  private anthropicHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.settings.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    this.applyAigToken(headers);
    return headers;
  }

  private applyAigToken(headers: Record<string, string>): void {
    if (this.settings.cfAigToken) {
      headers["cf-aig-authorization"] = `Bearer ${this.settings.cfAigToken}`;
    }
  }
}

function extractOpenAIContent(body: unknown): string {
  if (body === null || typeof body !== "object") {
    throw new DigestError("OpenAI response body was not an object.");
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new DigestError("OpenAI response had no choices.");
  }
  const first = choices[0];
  if (first === null || typeof first !== "object") {
    throw new DigestError("OpenAI first choice was not an object.");
  }
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== "object") {
    throw new DigestError("OpenAI response choice.message was missing.");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.length === 0) {
    throw new DigestError(
      "OpenAI response choice.message.content was not a non-empty string.",
    );
  }
  return content;
}

function extractAnthropicToolInput(body: unknown): unknown {
  if (body === null || typeof body !== "object") {
    throw new DigestError("Anthropic response body was not an object.");
  }
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new DigestError("Anthropic response had empty content array.");
  }
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "tool_use" && rec.name === DIGEST_TOOL_NAME) {
      return rec.input;
    }
  }
  throw new DigestError(
    `Anthropic response had no ${DIGEST_TOOL_NAME} tool_use block.`,
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 512);
  } catch {
    return "";
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DigestError("Response body was not valid JSON.");
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
