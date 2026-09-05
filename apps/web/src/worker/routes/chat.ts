import { Hono } from "hono";
import {
  USER_ID_HEADER,
  type AppContextEnv,
  type ChatAgentBinding,
  type Deps,
} from "../deps.js";
import {
  chatOwnerId,
  deleteConversationIndex,
  listConversations,
} from "../chat-index.js";
import { HttpError } from "../http-error.js";

export function createChatRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    const raw = new URL(c.req.url).searchParams.get("limit");
    const items = await listConversations(deps, userId, {
      ...(raw === null ? {} : { limit: Number(raw) }),
    });
    return c.json({ items });
  });

  router.get("/:id/messages", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    await assertChatAccess(deps, c.get("user").id, id);
    const stub = await requireConversation(deps.chatAgents, id);
    return c.json({ messages: await stub.chatMessages() });
  });

  router.delete("/:id", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    const id = c.req.param("id");
    await assertChatAccess(deps, userId, id);
    const stub = await requireConversation(deps.chatAgents, id);
    await stub.clearChat();
    await deleteConversationIndex(deps, userId, id);
    return c.body(null, 204);
  });

  // Everything else under /api/chat/:id belongs to the agent: the WebSocket
  // upgrade that carries the chat turns, and the SDK's own /get-messages.
  router.all("/:id", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    await assertChatAccess(deps, userId, c.req.param("id"));
    return toAgent(deps.chatAgents, withUserId(c.req.raw, userId));
  });
  router.all("/:id/*", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    await assertChatAccess(deps, userId, c.req.param("id"));
    return toAgent(deps.chatAgents, withUserId(c.req.raw, userId));
  });

  return router;
}

/**
 * 404 when the conversation exists and belongs to someone else; a missing row
 * is a brand-new conversation and is allowed — the first turn creates the index
 * row under the caller's id. Same message as a real miss, so existence never
 * leaks across tenants.
 */
async function assertChatAccess(
  deps: Deps,
  userId: string,
  id: string,
): Promise<void> {
  const owner = await chatOwnerId(deps.db, id);
  if (owner !== null && owner !== userId) {
    throw new HttpError(404, "not_found", "Conversation not found.");
  }
}

/**
 * The only place the Durable Object learns whose conversation it is hosting —
 * and it runs strictly after `assertChatAccess`.
 */
function withUserId(request: Request, userId: string): Request {
  const headers = new Headers(request.headers);
  headers.set(USER_ID_HEADER, userId); // set, not append: never trust an inbound copy
  return new Request(request, { headers });
}

async function toAgent(
  binding: ChatAgentBinding | null,
  request: Request,
): Promise<Response> {
  const routed = await binding?.route(request);
  if (!routed) throw chatUnavailable();
  return routed;
}

async function requireConversation(
  binding: ChatAgentBinding | null,
  id: string,
) {
  if (!binding) throw chatUnavailable();
  if (id.length === 0) {
    throw new HttpError(404, "not_found", "Conversation not found.");
  }
  return binding.get(id);
}

function chatUnavailable(): HttpError {
  return new HttpError(
    503,
    "chat_unavailable",
    "The chat agent binding is not configured.",
  );
}
