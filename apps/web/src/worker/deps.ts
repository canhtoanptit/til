import type { Db } from "@til/db";
import type { Extractor, LLMClient, LLMSettings } from "@til/core";
import type { AdaptersFactory, DigestWorkflowBinding } from "./digest.js";
import type { VectorizeLike } from "./vectorize.js";

export interface FetchPageFn {
  (url: string, fetchImpl?: typeof fetch): Promise<{ html: string; finalUrl: string }>;
}

export interface EmbedFn {
  (input: { title: string | null; summary: string | null; takeaway: string | null; tags: string[] }):
    Promise<number[] | null>;
}

export interface Deps {
  db: Db;
  now: () => number;
  llmFactory: (settings: LLMSettings) => LLMClient;
  extractor: Extractor;
  vectorize: VectorizeLike | null;
  embed: EmbedFn;
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

