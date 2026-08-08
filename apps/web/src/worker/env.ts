import type { TilChatAgent } from "./chat-agent.js";
import type { DigestRunParams } from "./digest.js";

export interface Env {
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;
  APP_TOKEN: string;
  DIGEST: Workflow<DigestRunParams>;
  CHAT: DurableObjectNamespace<TilChatAgent>;
  TIL_STACK?: string;
  OLLAMA_BASE_URL?: string;
}
