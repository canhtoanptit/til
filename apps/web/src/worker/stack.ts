import {
  createOllamaEmbedder,
  createWorkersAIRestEmbedder,
  EMBEDDING_DIMENSIONS,
  OLLAMA_DEFAULT_BASE_URL,
} from "@til/core";
import type { Embedder, Extractor, StackMode, VectorStore } from "@til/core";
import type { Db } from "@til/db";
import { isAiRunLike, WorkersAIEmbedder } from "./embedders.js";
import { ReadabilityExtractor, WorkersAIExtractor } from "./extractors.js";
import {
  D1VectorStore,
  isVectorizeIndexLike,
  VectorizeStore,
} from "./vector-store.js";

export const DEFAULT_STACK_MODE: StackMode = "local";

/** Which embedder `local` mode uses; see ADR-0010 (amended for workers-ai). */
export type LocalEmbedderKind = "ollama" | "workers-ai";

export const DEFAULT_LOCAL_EMBEDDER: LocalEmbedderKind = "ollama";

export interface StackEnv {
  TIL_STACK?: string | undefined;
  OLLAMA_BASE_URL?: string | undefined;
  TIL_EMBEDDER?: string | undefined;
  CF_ACCOUNT_ID?: string | undefined;
  WORKERS_AI_API_TOKEN?: string | undefined;
  AI?: unknown;
  VECTORIZE?: unknown;
}

export interface StackContext {
  db: Db;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type EmbedderStatus = "ok" | "unavailable";

export interface ResolvedStack {
  mode: StackMode;
  extractor: Extractor;
  // Null only in `cloud` mode when the AI / Vectorize bindings are absent —
  // they stay commented out in wrangler.jsonc until the deploy phase.
  embedder: Embedder | null;
  vectorStore: VectorStore | null;
  probeEmbedder: () => Promise<EmbedderStatus>;
}

/** Unknown, empty and absent values all mean `local` (ADR-0010). */
export function resolveStackMode(raw: string | undefined | null): StackMode {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "cloud") return "cloud";
  if (value === "local" || value === "") return DEFAULT_STACK_MODE;
  console.warn(
    `[stack] unknown TIL_STACK=${JSON.stringify(raw)} — falling back to '${DEFAULT_STACK_MODE}'.`,
  );
  return DEFAULT_STACK_MODE;
}

/** Unknown, empty and absent values all mean `ollama`. */
export function resolveLocalEmbedderKind(
  raw: string | undefined | null,
): LocalEmbedderKind {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "workers-ai") return "workers-ai";
  if (value === "ollama" || value === "") return DEFAULT_LOCAL_EMBEDDER;
  console.warn(
    `[stack] unknown TIL_EMBEDDER=${JSON.stringify(raw)} — falling back to '${DEFAULT_LOCAL_EMBEDDER}'.`,
  );
  return DEFAULT_LOCAL_EMBEDDER;
}

export function resolveStack(env: StackEnv, ctx: StackContext): ResolvedStack {
  const mode = resolveStackMode(env.TIL_STACK);
  const resolved = mode === "cloud" ? cloudStack(env) : localStack(env, ctx);
  logStackOnce(resolved);
  return resolved;
}

function cloudStack(env: StackEnv): ResolvedStack {
  const ai = env.AI ?? null;
  const index = env.VECTORIZE ?? null;
  const embedder = isAiRunLike(ai) ? new WorkersAIEmbedder(ai) : null;
  return {
    mode: "cloud",
    extractor: isAiToMarkdownLike(ai)
      ? new WorkersAIExtractor(ai)
      : new ReadabilityExtractor(),
    embedder,
    vectorStore: isVectorizeIndexLike(index)
      ? new VectorizeStore(index, EMBEDDING_DIMENSIONS)
      : null,
    // WHY: Workers AI has no free liveness endpoint — every call bills neurons —
    // so the binding's presence is the only cheap signal available.
    probeEmbedder: async () => (embedder === null ? "unavailable" : "ok"),
  };
}

function localStack(env: StackEnv, ctx: StackContext): ResolvedStack {
  const leg =
    resolveLocalEmbedderKind(env.TIL_EMBEDDER) === "workers-ai"
      ? workersAiRestLeg(env, ctx)
      : ollamaLeg(env, ctx);
  return {
    mode: "local",
    extractor: new ReadabilityExtractor(),
    embedder: leg.embedder,
    vectorStore: new D1VectorStore(
      ctx.db,
      EMBEDDING_DIMENSIONS,
      ctx.now ?? Date.now,
    ),
    probeEmbedder: leg.probeEmbedder,
  };
}

interface EmbedderLeg {
  embedder: Embedder | null;
  probeEmbedder: () => Promise<EmbedderStatus>;
}

function ollamaLeg(env: StackEnv, ctx: StackContext): EmbedderLeg {
  const baseUrl = stripTrailingSlash(
    env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL,
  );
  const options: Parameters<typeof createOllamaEmbedder>[0] = { baseUrl };
  if (ctx.fetchImpl !== undefined) options.fetchImpl = ctx.fetchImpl;
  const embedder = createOllamaEmbedder(options);
  return {
    embedder,
    probeEmbedder: () =>
      probeOllama(baseUrl, embedder.model, ctx.fetchImpl, ctx.now ?? Date.now),
  };
}

function workersAiRestLeg(env: StackEnv, ctx: StackContext): EmbedderLeg {
  const accountId = (env.CF_ACCOUNT_ID ?? "").trim();
  const apiToken = (env.WORKERS_AI_API_TOKEN ?? "").trim();
  if (accountId.length === 0 || apiToken.length === 0) {
    warnOnce(
      "[stack] TIL_EMBEDDER=workers-ai needs both CF_ACCOUNT_ID and WORKERS_AI_API_TOKEN — running without an embedder, so search degrades to FTS-only.",
    );
    return { embedder: null, probeEmbedder: async () => "unavailable" };
  }
  const options: Parameters<typeof createWorkersAIRestEmbedder>[0] = {
    accountId,
    apiToken,
  };
  if (ctx.fetchImpl !== undefined) options.fetchImpl = ctx.fetchImpl;
  return {
    embedder: createWorkersAIRestEmbedder(options),
    // WHY: same as `cloud` — every Workers AI call bills neurons, so having the
    // credentials is the only free signal there is.
    probeEmbedder: async () => "ok",
  };
}

const PROBE_TIMEOUT_MS = 1_500;
const PROBE_TTL_MS = 5_000;

const probeCache = new Map<string, { at: number; status: EmbedderStatus }>();

/**
 * `/api/tags` lists the pulled models: it neither loads a model nor bills
 * anything, and it answers both "is Ollama running" and "is bge-m3 pulled".
 * Never throws — the health route must always answer.
 */
async function probeOllama(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch | undefined,
  now: () => number,
): Promise<EmbedderStatus> {
  const key = `${baseUrl}|${model}`;
  const at = now();
  const cached = probeCache.get(key);
  if (cached && at - cached.at < PROBE_TTL_MS) return cached.status;

  const status = await runOllamaProbe(baseUrl, model, fetchImpl);
  probeCache.set(key, { at, status });
  return status;
}

async function runOllamaProbe(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch | undefined,
): Promise<EmbedderStatus> {
  const impl = fetchImpl ?? globalThis.fetch;
  if (typeof impl !== "function") return "unavailable";
  try {
    const response = await impl(`${baseUrl}/api/tags`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return "unavailable";
    const body: unknown = await response.json();
    const models = (body as { models?: unknown }).models;
    if (!Array.isArray(models)) return "unavailable";
    for (const entry of models) {
      const name = (entry as { name?: unknown }).name;
      // Ollama reports tags, so the pulled model is e.g. `bge-m3:latest`.
      if (typeof name === "string" && name.split(":")[0] === model) return "ok";
    }
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// `buildDeps` runs per request; a misconfiguration is a property of the isolate,
// so say it once rather than on every hit.
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

// `buildDeps` runs per request; the resolved stack is a property of the isolate,
// so log it once instead of on every hit.
let loggedStack: string | null = null;

function logStackOnce(resolved: ResolvedStack): void {
  const line = `[stack] mode=${resolved.mode} extractor=${resolved.extractor.constructor.name} embedder=${describe(resolved.embedder)} vectors=${describe(resolved.vectorStore)}`;
  if (loggedStack === line) return;
  loggedStack = line;
  console.log(line);
}

function describe(adapter: object | null): string {
  return adapter === null ? "none" : adapter.constructor.name;
}

function isAiToMarkdownLike(
  ai: unknown,
): ai is ConstructorParameters<typeof WorkersAIExtractor>[0] {
  return (
    typeof ai === "object" &&
    ai !== null &&
    typeof (ai as { toMarkdown?: unknown }).toMarkdown === "function"
  );
}
