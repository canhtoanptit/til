import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { DigestError } from "./errors.js";
import {
  buildSynthesisUserMessage,
  buildUserMessage,
  DIGEST_SYSTEM_PROMPT,
  jsonModeSystemPrompt,
  parseDigest,
  parseSynthesis,
  SYNTHESIS_SYSTEM_PROMPT,
  synthesisJsonModeSystemPrompt,
} from "./prompt.js";
import type {
  Digest,
  DigestSynthesis,
  LLMClient,
  LLMSettings,
  SynthesisInput,
} from "./types.js";
import { gatewayBaseURL } from "./url.js";

const digestSchema = z.object({
  title: z.string(),
  summary: z.string(),
  takeaway: z.string(),
  question: z.string(),
  tags: z.array(z.string()).min(3).max(6),
});

const synthesisSchema = z.object({
  title: z.string(),
  intro: z.string(),
  items: z.array(
    z.object({
      canonicalUrl: z.string(),
      title: z.string(),
      why: z.string(),
    }),
  ),
});

export class AISDKClient implements LLMClient {
  private readonly settings: LLMSettings;
  private readonly model: LanguageModel;

  constructor(settings: LLMSettings, fetchImpl?: typeof fetch) {
    this.settings = settings;
    this.model = createModel(settings, fetchImpl);
  }

  async digest(
    markdown: string,
    meta: { url: string; title?: string },
  ): Promise<Digest> {
    const user = buildUserMessage(markdown, meta);
    // WHY: most Groq models reject response_format json_schema, so ask for
    // json_object mode and carry the schema in the prompt instead.
    const jsonMode = this.settings.provider === "groq";
    try {
      const { output } = await generateText({
        model: this.model,
        system: jsonMode ? jsonModeSystemPrompt() : DIGEST_SYSTEM_PROMPT,
        prompt: user,
        ...(jsonMode
          ? { providerOptions: { groq: { structuredOutputs: false } } }
          : {}),
        output: Output.object({
          schema: digestSchema,
          name: "digest",
          description: "Structured digest of the article.",
        }),
      });
      return parseDigest(output);
    } catch (err) {
      if (err instanceof DigestError) throw err;
      throw new DigestError(
        `AI SDK digest failed: ${describeError(err)}`,
      );
    }
  }

  async synthesizeDigest(
    inputs: SynthesisInput[],
    opts: { windowDays: number; maxItems: number },
  ): Promise<DigestSynthesis> {
    const user = buildSynthesisUserMessage(inputs, opts);
    const jsonMode = this.settings.provider === "groq";
    try {
      const { output } = await generateText({
        model: this.model,
        system: jsonMode
          ? synthesisJsonModeSystemPrompt()
          : SYNTHESIS_SYSTEM_PROMPT,
        prompt: user,
        ...(jsonMode
          ? { providerOptions: { groq: { structuredOutputs: false } } }
          : {}),
        output: Output.object({
          schema: synthesisSchema,
          name: "digest_synthesis",
          description: "Selected and ordered items for the weekly digest.",
        }),
      });
      return parseSynthesis(output, inputs, opts.maxItems);
    } catch (err) {
      if (err instanceof DigestError) throw err;
      throw new DigestError(
        `AI SDK synthesis failed: ${describeError(err)}`,
      );
    }
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await generateText({
        model: this.model,
        prompt: "ping",
        maxOutputTokens: 1,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: describeError(err) };
    }
  }
}

function createModel(
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

function aigHeaders(settings: LLMSettings): Record<string, string> | undefined {
  if (!settings.cfAigToken) return undefined;
  return { "cf-aig-authorization": `Bearer ${settings.cfAigToken}` };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
