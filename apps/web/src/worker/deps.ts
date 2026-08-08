import type { Db } from "@til/db";
import type {
  Embedder,
  Extractor,
  LLMClient,
  LLMSettings,
  StackMode,
  VectorStore,
} from "@til/core";
import type { ChatMessageDTO } from "./chat-dto.js";
import type { AdaptersFactory, DigestWorkflowBinding } from "./digest.js";

export interface FetchPageFn {
  (url: string, fetchImpl?: typeof fetch): Promise<{ html: string; finalUrl: string }>;
}

/**
 * The Agents SDK routes `/{prefix}/{kebab-cased binding name}/{instance}`. With
 * the binding named CHAT this prefix puts the agent's own surface on the
 * contract path `/api/chat/:id`, inside the space the bearer middleware guards.
 */
export const CHAT_AGENT_PREFIX = "api";

/** The subset of the chat Durable Object the REST routes need, over DO RPC. */
export interface ChatConversationStub {
  chatMessages(): Promise<ChatMessageDTO[]>;
  clearChat(): Promise<void>;
}

/**
 * Seam over the CHAT Durable Object namespace. `route` hands a request to the
 * agent's own handler (the WebSocket upgrade that carries chat turns, and the
 * SDK's `/get-messages`) and resolves null when no agent matched the URL.
 */
export interface ChatAgentBinding {
  get(id: string): Promise<ChatConversationStub>;
  route(request: Request): Promise<Response | null>;
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
  // Null whenever the CHAT Durable Object binding is not configured.
  chatAgents: ChatAgentBinding | null;
}

export interface AppToken {
  APP_TOKEN: string;
}

export interface AppContextEnv {
  Bindings: AppToken;
  Variables: { deps: Deps };
}
