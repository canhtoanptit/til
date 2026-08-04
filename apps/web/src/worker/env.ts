import type { DigestRunParams } from "./digest.js";

export interface Env {
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;
  APP_TOKEN: string;
  DIGEST: Workflow<DigestRunParams>;
  TIL_STACK?: string;
  OLLAMA_BASE_URL?: string;
}
