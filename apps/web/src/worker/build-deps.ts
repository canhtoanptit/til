import { createDb } from "@til/db";
import { createLLMClient } from "@til/core";
import type { Deps } from "./deps.js";
import { createDefaultAdapters, type DigestWorkflowBinding } from "./digest.js";
import type { Env } from "./env.js";
import { selectExtractor } from "./extractors.js";
import { fetchPage } from "./fetch-page.js";
import { embeddingTextFor, WorkersAIEmbedder } from "./vectorize.js";

export interface ExecCtx {
  waitUntil: (p: Promise<unknown>) => void;
}

export function buildDeps(env: Env, ctx: ExecCtx): Deps {
  // WHY: `env.AI` and `env.VECTORIZE` bindings are commented out in wrangler.jsonc
  // for local dev; the typed shape claims they exist. Guard at runtime.
  const ai = (env as unknown as { AI?: unknown }).AI ?? null;
  const vectorize =
    (env as unknown as { VECTORIZE?: unknown }).VECTORIZE ?? null;
  // WHY: typed as always present, but absent at runtime whenever the workflows
  // binding is not configured (e.g. a stripped-down local dev config).
  const digestWorkflow: DigestWorkflowBinding | null = env.DIGEST ?? null;
  const db = createDb(env.DB);
  const extractor = selectExtractor(ai);
  const embedder = ai ? new WorkersAIEmbedder(ai as never) : null;

  return {
    db,
    now: () => Date.now(),
    llmFactory: (settings) => createLLMClient(settings),
    extractor,
    vectorize: (vectorize as Deps["vectorize"]) ?? null,
    embed: async (input) => {
      if (!embedder) return null;
      const text = embeddingTextFor(input);
      return embedder.embed(text);
    },
    fetchPage,
    waitUntil: (p) => ctx.waitUntil(p),
    fetchImpl: (typeof fetch === "function"
      ? fetch.bind(globalThis)
      : globalThis.fetch) as typeof fetch,
    adapters: createDefaultAdapters,
    digestWorkflow,
  };
}
