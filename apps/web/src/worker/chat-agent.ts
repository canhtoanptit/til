import { AIChatAgent } from "@cloudflare/ai-chat";
import { buildDeps } from "./build-deps.js";
import {
  parseStamp,
  toChatMessageDTO,
  type ChatMessageDTO,
} from "./chat-dto.js";
import { chatTurnResponse, touchConversation } from "./chat-turn.js";
import type { Deps } from "./deps.js";
import type { Env } from "./env.js";

/** Storage ceiling per conversation; unrelated to what is sent to the model. */
const MAX_PERSISTED_MESSAGES = 200;

type OnFinish = Parameters<AIChatAgent<Env>["onChatMessage"]>[0];
type TurnOptions = Parameters<AIChatAgent<Env>["onChatMessage"]>[1];

/**
 * The chat conversation. `AIChatAgent` owns the transport (WebSocket frames,
 * message persistence in the agent's own SQLite, resumable streams); everything
 * TIL-specific lives in `chatTurnResponse`.
 */
export class TilChatAgent extends AIChatAgent<Env> {
  override maxPersistedMessages = MAX_PERSISTED_MESSAGES;

  override async onChatMessage(
    _onFinish: OnFinish,
    options?: TurnOptions,
  ): Promise<Response | undefined> {
    return chatTurnResponse(this.deps(), {
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
    await touchConversation(this.deps(), this.name, this.messages);
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
