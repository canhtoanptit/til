import { Hono } from "hono";
import { mintChatTicket } from "../auth.js";
import type { AppContextEnv, ChatAgentBinding } from "../deps.js";
import { deleteConversationIndex, listConversations } from "../chat-index.js";
import { HttpError } from "../http-error.js";

export function createChatRouter() {
  const router = new Hono<AppContextEnv>();

  // Registered before the `/:id` catch-all so it is never read as a
  // conversation id. Conversation ids are uuids, so no collision in practice.
  router.post("/ticket", async (c) => {
    const deps = c.get("deps");
    return c.json(await mintChatTicket(c.env.APP_TOKEN, deps.now()));
  });

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const raw = new URL(c.req.url).searchParams.get("limit");
    const items = await listConversations(deps, {
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
    const id = c.req.param("id");
    const stub = await requireConversation(deps.chatAgents, id);
    await stub.clearChat();
    await deleteConversationIndex(deps, id);
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
