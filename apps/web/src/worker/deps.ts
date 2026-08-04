import type { Db } from "@til/db";
import type {
  Embedder,
  Extractor,
  LLMClient,
  LLMSettings,
  StackMode,
  VectorStore,
} from "@til/core";
import type { AdaptersFactory, DigestWorkflowBinding } from "./digest.js";

export interface FetchPageFn {
  (url: string, fetchImpl?: typeof fetch): Promise<{ html: string; finalUrl: string }>;
}

export interface Deps {
  db: Db;
  now: () => number;
  stack: StackMode;
  llmFactory: (settings: LLMSettings) => LLMClient;
  extractor: Extractor;
  // Null whenever the selected stack has no usable binding — `cloud` mode before
  // the AI/Vectorize bindings are enabled. Retrieval then degrades to FTS-only.
  embedder: Embedder | null;
  vectorStore: VectorStore | null;
  // Cheap liveness check for GET /api/health; must never throw.
  probeEmbedder: () => Promise<"ok" | "unavailable">;
  fetchPage: FetchPageFn;
  waitUntil: (p: Promise<unknown>) => void;
  fetchImpl: typeof fetch;
  adapters: AdaptersFactory;
  digestWorkflow: DigestWorkflowBinding | null;
}

export interface AppToken {
  APP_TOKEN: string;
}

export interface AppContextEnv {
  Bindings: AppToken;
  Variables: { deps: Deps };
}
