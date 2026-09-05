import { AIChatAgent } from "@cloudflare/ai-chat";
import type { Connection, ConnectionContext } from "agents";
import { OWNER_USER_ID } from "@til/db";
import { buildDeps } from "./build-deps.js";
import {
  parseStamp,
  toChatMessageDTO,
  type ChatMessageDTO,
} from "./chat-dto.js";
import { chatOwnerId } from "./chat-index.js";
import { chatTurnResponse, touchConversation } from "./chat-turn.js";
import { USER_ID_HEADER, type Deps } from "./deps.js";
import type { Env } from "./env.js";

/** Storage ceiling per conversation; unrelated to what is sent to the model. */
const MAX_PERSISTED_MESSAGES = 200;

/** DO storage key holding the id of the person this conversation belongs to. */
const USER_STORAGE_KEY = "til:user-id";

type OnFinish = Parameters<AIChatAgent<Env>["onChatMessage"]>[0];
type TurnOptions = Parameters<AIChatAgent<Env>["onChatMessage"]>[1];

/**
 * The chat conversation. `AIChatAgent` owns the transport (WebSocket frames,
 * message persistence in the agent's own SQLite, resumable streams); everything
 * TIL-specific lives in `chatTurnResponse`.
 */
export class TilChatAgent extends AIChatAgent<Env> {
  override maxPersistedMessages = MAX_PERSISTED_MESSAGES;

  private cachedUserId: string | null = null;

  /**
   * Every contact goes through one of these two entry points: the WebSocket
   * handshake (`onConnect`) or plain HTTP (`onRequest`). The chat proxy stamps
   * `x-til-user-id` on both AFTER verifying the conversation against the
   * `chats` index, so the header is trusted here. The id is persisted because
   * hibernated WebSockets deliver later messages WITHOUT re-running
   * `onConnect` — the in-memory cache dies with the isolate, DO storage does
   * not.
   *
   * Both hooks are declared by partyserver's `Server` (`onConnect(connection,
   * ctx)` / `onRequest(request)`); `Agent` and `AIChatAgent` do not override
   * them on the prototype, they wrap them in their constructors — so `super`
   * reaches the framework default and the SDK's own wrappers still run *around*
   * these methods, not instead of them.
   */
  override async onConnect(
    connection: Connection,
    ctx: ConnectionContext,
  ): Promise<void> {
    await this.captureUserId(ctx.request);
    await super.onConnect(connection, ctx);
  }

  /**
   * NOTE: `AIChatAgent`'s own wrapper answers the SDK's `/get-messages` before
   * delegating here, so that one path never reaches `captureUserId`. Harmless:
   * it is DO-local, the route already checked ownership, and `userId()` falls
   * back to the index row anyway.
   */
  override async onRequest(request: Request): Promise<Response> {
    await this.captureUserId(request);
    return super.onRequest(request);
  }

  private async captureUserId(request: Request | undefined): Promise<void> {
    const id = request?.headers.get(USER_ID_HEADER);
    if (!id || id === this.cachedUserId) return;
    this.cachedUserId = id;
    await this.ctx.storage.put(USER_STORAGE_KEY, id);
  }

  /**
   * Storage → the `chats` index row → `owner`. The middle step is what makes a
   * pre-multi-user conversation (a DO that has never seen the header) resolve
   * to the tenant its index row already names, and the last is the backstop for
   * a conversation that predates the index entirely.
   */
  private async userId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    const stored = await this.ctx.storage.get<string>(USER_STORAGE_KEY);
    const resolved =
      stored ?? (await chatOwnerId(this.deps().db, this.name)) ?? OWNER_USER_ID;
    this.cachedUserId = resolved;
    if (!stored) await this.ctx.storage.put(USER_STORAGE_KEY, resolved);
    return resolved;
  }

  override async onChatMessage(
    _onFinish: OnFinish,
    options?: TurnOptions,
  ): Promise<Response | undefined> {
    return chatTurnResponse(this.deps(), {
      userId: await this.userId(),
      conversationId: this.name,
      messages: this.messages,
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  }

  /** RPC: the transcript for `GET /api/chat/:id/messages`. */
  async chatMessages(): Promise<ChatMessageDTO[]> {
    const stamps = this.messageTimestamps();
    const out: ChatMessageDTO[] = [];
    for (const message of this.messages) {
      const dto = toChatMessageDTO(message, stamps.get(message.id) ?? 0);
      if (dto) out.push(dto);
    }
    return out;
  }

  /**
   * RPC: drop the transcript for `DELETE /api/chat/:id`. Deliberately not
   * `Agent.destroy()`, which aborts the isolate and so cannot be awaited
   * cleanly by an HTTP handler that still has to answer 204.
   */
  async clearChat(): Promise<void> {
    this.resetTurnState();
    void this.sql`delete from cf_ai_chat_agent_messages`;
    this.messages = [];
  }

  protected override async onChatResponse(): Promise<void> {
    await touchConversation(
      this.deps(),
      await this.userId(),
      this.name,
      this.messages,
    );
  }

  private deps(): Deps {
    return buildDeps(this.env, {
      waitUntil: (p) => {
        this.ctx.waitUntil(p);
      },
    });
  }

  /**
   * `this.messages` carries no timestamps, so `created_at` is read from the
   * message table `AIChatAgent` maintains in this agent's SQLite. Internal to
   * the SDK, hence best-effort: a rename costs timestamps, not the transcript.
   */
  private messageTimestamps(): Map<string, number> {
    const stamps = new Map<string, number>();
    try {
      const rows = this.sql<{ id: string; created_at: string | number | null }>`
        select id, created_at from cf_ai_chat_agent_messages
      `;
      for (const row of rows) stamps.set(row.id, parseStamp(row.created_at));
    } catch (err) {
      console.warn(
        "[chat] could not read message timestamps:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return stamps;
  }
}
