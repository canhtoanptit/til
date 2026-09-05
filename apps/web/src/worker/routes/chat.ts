import { Hono } from "hono";
import type { AppContextEnv, ChatAgentBinding } from "../deps.js";
import { deleteConversationIndex, listConversations } from "../chat-index.js";
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
    const stub = await requireConversation(
      c.get("deps").chatAgents,
      c.req.param("id"),
    );
    return c.json({ messages: await stub.chatMessages() });
  });

  router.delete("/:id", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const stub = await requireConversation(deps.chatAgents, id);
    await stub.clearChat();
    await deleteConversationIndex(deps, userId, id);
    return c.body(null, 204);
  });

  // Everything else under /api/chat/:id belongs to the agent: the WebSocket
  // upgrade that carries the chat turns, and the SDK's own /get-messages.
  router.all("/:id", (c) => toAgent(c.get("deps").chatAgents, c.req.raw));
  router.all("/:id/*", (c) => toAgent(c.get("deps").chatAgents, c.req.raw));

  return router;
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
