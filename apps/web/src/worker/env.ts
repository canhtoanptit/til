import type { TilChatAgent } from "./chat-agent.js";
import type { DigestRunParams } from "./digest.js";

export interface Env {
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;
  DIGEST: Workflow<DigestRunParams>;
  CHAT: DurableObjectNamespace<TilChatAgent>;
  // Google sign-in (ADR-0013). Secrets in production, `.dev.vars` locally;
  // optional so a worker without them still serves the SPA and /api/health.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OWNER_EMAIL?: string;
  TIL_STACK?: string;
  /** Positive integer as a string; overrides the 10 saves/user/UTC-day cap. */
  ENTRY_DAILY_LIMIT?: string;
  OLLAMA_BASE_URL?: string;
  TIL_EMBEDDER?: string;
  CF_ACCOUNT_ID?: string;
  WORKERS_AI_API_TOKEN?: string;
}
