import { chats } from "@til/db";
import { desc, eq } from "drizzle-orm";
import type { Deps } from "./deps.js";
import type { ChatSummaryDTO } from "./chat-dto.js";

export const CHAT_LIST_DEFAULT_LIMIT = 50;
export const CHAT_LIST_MAX_LIMIT = 200;

/**
 * Upserts one conversation into the cross-DO index. Called by the chat agent as
 * turns complete; the title is only written once, so a conversation keeps the
 * wording of its opening question.
 */
export async function indexConversation(
  deps: Deps,
  id: string,
  fields: { title: string | null; messageCount: number },
): Promise<void> {
  const now = deps.now();
  const existing = await deps.db
    .select({ id: chats.id, title: chats.title })
    .from(chats)
    .where(eq(chats.id, id))
    .limit(1);
  const row = existing[0];
  if (!row) {
    await deps.db.insert(chats).values({
      id,
      title: fields.title,
      messageCount: fields.messageCount,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  await deps.db
    .update(chats)
    .set({
      title: row.title ?? fields.title,
      messageCount: fields.messageCount,
      updatedAt: now,
    })
    .where(eq(chats.id, id));
}

export async function listConversations(
  deps: Deps,
  opts: { limit?: number } = {},
): Promise<ChatSummaryDTO[]> {
  const limit = clampLimit(opts.limit);
  const rows = await deps.db
    .select({
      id: chats.id,
      title: chats.title,
      updatedAt: chats.updatedAt,
      messageCount: chats.messageCount,
    })
    .from(chats)
    .orderBy(desc(chats.updatedAt), desc(chats.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? null,
    updatedAt: row.updatedAt,
    messageCount: row.messageCount,
  }));
}

export async function deleteConversationIndex(
  deps: Deps,
  id: string,
): Promise<void> {
  await deps.db.delete(chats).where(eq(chats.id, id));
}

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return CHAT_LIST_DEFAULT_LIMIT;
  return Math.min(CHAT_LIST_MAX_LIMIT, Math.max(1, Math.trunc(raw)));
}
