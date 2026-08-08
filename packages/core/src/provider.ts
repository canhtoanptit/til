import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { LLMSettings } from "./types.js";
import { gatewayBaseURL } from "./url.js";

/**
 * ADR-0002 guardrail 1: every model is an explicit provider instance pointed at
 * the user's Cloudflare AI Gateway. A plain string model id would route through
 * Vercel's paid gateway instead, so this is the only place a model is built.
 */
export function createModel(
  settings: LLMSettings,
  fetchImpl?: typeof fetch,
): LanguageModel {
  const base = gatewayBaseURL(settings);
  if (settings.provider === "openai") {
    const provider = createOpenAI({
      apiKey: settings.apiKey,
      baseURL: base,
      headers: aigHeaders(settings),
      fetch: fetchImpl,
    });
    return provider.chat(settings.model);
  }
  if (settings.provider === "groq") {
    const provider = createGroq({
      apiKey: settings.apiKey,
      baseURL: base,
      headers: aigHeaders(settings),
      fetch: fetchImpl,
    });
    return provider(settings.model);
  }
  const provider = createAnthropic({
    apiKey: settings.apiKey,
    baseURL: `${base}/v1`,
    headers: aigHeaders(settings),
    fetch: fetchImpl,
  });
  return provider(settings.model);
}

export function aigHeaders(
  settings: LLMSettings,
): Record<string, string> | undefined {
  if (!settings.cfAigToken) return undefined;
  return { "cf-aig-authorization": `Bearer ${settings.cfAigToken}` };
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
