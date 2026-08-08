import { getAgentByName, routeAgentRequest } from "agents";
import { createDb } from "@til/db";
import { createLLMClient } from "@til/core";
import type { TilChatAgent } from "./chat-agent.js";
import { CHAT_AGENT_PREFIX, type ChatAgentBinding, type Deps } from "./deps.js";
import { createDefaultAdapters, type DigestWorkflowBinding } from "./digest.js";
import type { Env } from "./env.js";
import { fetchPage } from "./fetch-page.js";
import { resolveStack } from "./stack.js";

export interface ExecCtx {
  waitUntil: (p: Promise<unknown>) => void;
}

export function buildDeps(env: Env, ctx: ExecCtx): Deps {
  // WHY: typed as always present, but absent at runtime whenever the workflows
  // binding is not configured (e.g. a stripped-down local dev config).
  const digestWorkflow: DigestWorkflowBinding | null = env.DIGEST ?? null;
  const chatAgents = resolveChatAgents(env);
  const db = createDb(env.DB);
  const now = () => Date.now();
  const fetchImpl = (typeof fetch === "function"
    ? fetch.bind(globalThis)
    : globalThis.fetch) as typeof fetch;
  // WHY: `env.AI`/`env.VECTORIZE` are typed as always present, but their
  // bindings stay commented out in wrangler.jsonc — resolveStack guards at
  // runtime and leaves the corresponding adapter null.
  const stack = resolveStack(env, { db, fetchImpl, now });

  return {
    db,
    now,
    stack: stack.mode,
    llmFactory: (settings) => createLLMClient(settings),
    extractor: stack.extractor,
    embedder: stack.embedder,
    vectorStore: stack.vectorStore,
    probeEmbedder: stack.probeEmbedder,
    fetchPage,
    waitUntil: (p) => ctx.waitUntil(p),
    fetchImpl,
    adapters: createDefaultAdapters,
    digestWorkflow,
    chatAgents,
  };
}

// Same runtime guard as DIGEST: typed as always present, absent whenever the
// durable_objects binding is not configured.
function resolveChatAgents(env: Env): ChatAgentBinding | null {
  const namespace = env.CHAT;
  if (!namespace) return null;
  return {
    get: async (id) => {
      const stub = await getAgentByName<Env, TilChatAgent>(namespace, id);
      return {
        chatMessages: () => stub.chatMessages(),
        clearChat: () => stub.clearChat(),
      };
    },
    route: (request) =>
      routeAgentRequest(request, env, { prefix: CHAT_AGENT_PREFIX }),
  };
}
