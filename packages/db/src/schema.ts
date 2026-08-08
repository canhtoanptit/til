import { desc } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title"),
    sourceDomain: text("source_domain"),
    contentMarkdown: text("content_markdown"),
    summary: text("summary"),
    takeaway: text("takeaway"),
    question: text("question"),
    tags: text("tags").notNull().default("[]"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("entries_canonical_url_uq").on(t.canonicalUrl),
    index("entries_status_idx").on(t.status),
    index("entries_created_at_idx").on(t.createdAt),
  ],
);

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  apiKey: text("api_key").notNull(),
  cfAccountId: text("cf_account_id").notNull(),
  cfGatewayId: text("cf_gateway_id").notNull(),
  cfAigToken: text("cf_aig_token"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const digests = sqliteTable(
  "digests",
  {
    id: text("id").primaryKey(),
    runAt: integer("run_at").notNull(),
    windowDays: integer("window_days").notNull(),
    status: text("status").notNull().default("pending"),
    title: text("title"),
    intro: text("intro"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("digests_run_at_idx").on(desc(t.runAt))],
);

export const digestItems = sqliteTable(
  "digest_items",
  {
    id: text("id").primaryKey(),
    digestId: text("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    sourceName: text("source_name").notNull(),
    sourceDomain: text("source_domain").notNull(),
    score: real("score").notNull(),
    why: text("why"),
    evidence: text("evidence").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("digest_items_digest_id_rank_idx").on(t.digestId, t.rank)],
);

/**
 * A cross-Durable-Object index of chat conversations. The transcript itself
 * lives in each chat DO's own SQLite; a DO cannot enumerate its siblings, so the
 * conversation list is maintained here by the DO as turns complete.
 */
export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("chats_updated_at_idx").on(desc(t.updatedAt))],
);

export const entryVectors = sqliteTable("entry_vectors", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id, { onDelete: "cascade" }),
  embedModel: text("embed_model").notNull(),
  dims: integer("dims").notNull(),
  // JSON-encoded number[]; D1 has no array/vector type and cannot load sqlite-vec.
  values: text("values").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;
export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
export type DigestRun = typeof digests.$inferSelect;
export type NewDigestRun = typeof digests.$inferInsert;
export type DigestItem = typeof digestItems.$inferSelect;
export type NewDigestItem = typeof digestItems.$inferInsert;
export type EntryVector = typeof entryVectors.$inferSelect;
export type NewEntryVector = typeof entryVectors.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
