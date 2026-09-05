import { desc } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

/**
 * The placeholder tenant every pre-multi-user row was backfilled to (migration
 * 0012); claimed via OWNER_EMAIL at first login.
 */
export const OWNER_USER_ID = "owner";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    googleSub: text("google_sub"),
    email: text("email").notNull(),
    name: text("name"),
    picture: text("picture"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("users_google_sub_uq").on(t.googleSub)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    /**
     * Tenant key (migration 0012). The SQL column carries DEFAULT 'owner' — that is
     * the backfill for pre-0012 rows, not an app behaviour — so it is deliberately
     * NOT declared here: every insert site must name its user or fail to compile.
     * No .references(): SQLite cannot add an FK via ALTER TABLE (app-level
     * integrity, the `feedback` stance).
     */
    userId: text("user_id").notNull(),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title"),
    sourceDomain: text("source_domain"),
    contentMarkdown: text("content_markdown"),
    summary: text("summary"),
    takeaway: text("takeaway"),
    question: text("question"),
    tags: text("tags").notNull().default("[]"),
    /**
     * What kind of thing the entry points at (P25) — 'article' | 'pdf' | 'video',
     * typed as `ContentType` at the DTO seam rather than here, because the column
     * carries no CHECK constraint (see migration 0010) and so cannot promise the
     * vocabulary. 'article' is the default, which is what every row written before
     * this column existed means, and what any unrecognised value is read as.
     *
     * Written twice per entry on purpose: `POST /api/entries` stores the URL-phase
     * guess so the UI can badge a pending video immediately, and ingest overwrites
     * it with what the fetch actually turned out to be.
     */
    contentType: text("content_type").notNull().default("article"),
    /**
     * The owner's own marks on the entry (P23) — everything above this line was
     * written by the ingest pipeline. Both flags are stored as the integer SQLite
     * has (0/1) and read as booleans, the `feeds.enabled` precedent, so a route
     * never has to remember which end of the seam it is on.
     *
     * `note` is null until the owner writes one, which is deliberately a
     * different value from "": PATCH /api/entries/:id maps an empty-string note
     * back to null, so "no note" has exactly one representation in the column.
     */
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("entries_user_canonical_url_uq").on(t.userId, t.canonicalUrl),
    index("entries_status_idx").on(t.status),
    index("entries_created_at_idx").on(t.createdAt),
    index("entries_user_created_at_idx").on(t.userId, t.createdAt),
  ],
);

export const settings = sqliteTable(
  "settings",
  {
    /**
     * `autoIncrement` here is type-level only: it is what makes `id` optional in
     * `NewSettings`, so a per-user insert can let the rowid self-assign. The real
     * DDL (0000) is a plain `integer PRIMARY KEY` rowid alias and is frozen —
     * migrations are append-only, and a rowid alias already self-assigns.
     */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Tenant key (migration 0012) — see the comment on `entries.userId`. */
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    apiKey: text("api_key").notNull(),
    cfAccountId: text("cf_account_id").notNull(),
    cfGatewayId: text("cf_gateway_id").notNull(),
    cfAigToken: text("cf_aig_token"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("settings_user_uq").on(t.userId)],
);

export const digests = sqliteTable(
  "digests",
  {
    id: text("id").primaryKey(),
    /** Tenant key (migration 0012) — see the comment on `entries.userId`. */
    userId: text("user_id").notNull(),
    runAt: integer("run_at").notNull(),
    windowDays: integer("window_days").notNull(),
    /**
     * 'weekly' | 'monthly-report' (migration 0011). Not nullable: rows written
     * before the monthly report existed are weekly runs, and the column default
     * says so, so no reader has to translate NULL into a flavour.
     */
    kind: text("kind").notNull().default("weekly"),
    status: text("status").notNull().default("pending"),
    title: text("title"),
    intro: text("intro"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("digests_run_at_idx").on(desc(t.runAt)),
    index("digests_user_run_at_idx").on(t.userId, desc(t.runAt)),
  ],
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
    /**
     * Max cosine similarity between this item and the owner's recent saved
     * reading (C18). Null means personalization did not run for the item — no
     * embedder, no stored entry vectors, or an embedder failure that degraded the
     * run — which is a different statement from 0, "measured, nothing matched".
     */
    interestScore: real("interest_score"),
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
    /** Tenant key (migration 0012) — see the comment on `entries.userId`. */
    userId: text("user_id").notNull(),
    title: text("title"),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("chats_updated_at_idx").on(desc(t.updatedAt)),
    index("chats_user_updated_at_idx").on(t.userId, desc(t.updatedAt)),
  ],
);

/**
 * The owner's RSS/Atom sources for the digest. `enabled` is stored as the integer
 * SQLite has (0/1) and read as a boolean, so a route never has to remember which
 * end of the seam it is on.
 */
export const feeds = sqliteTable(
  "feeds",
  {
    id: text("id").primaryKey(),
    /** Tenant key (migration 0012) — see the comment on `entries.userId`. */
    userId: text("user_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("feeds_user_url_uq").on(t.userId, t.url),
    index("feeds_enabled_idx").on(t.enabled),
  ],
);

/**
 * One spaced-repetition card per entry. `state` is 'new' | 'learning' | 'review';
 * `dueAt`/`reviewedAt` are epoch ms like every other timestamp here, and
 * `intervalDays` is null until the card has been graded once. The scheduling math
 * itself lives in `@til/core` (scheduleReview) — this table only stores its output.
 */
export const reviews = sqliteTable(
  "reviews",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id, { onDelete: "cascade" }),
    /** Tenant key (migration 0012) — see the comment on `entries.userId`. */
    userId: text("user_id").notNull(),
    state: text("state").notNull().default("new"),
    dueAt: integer("due_at"),
    intervalDays: real("interval_days"),
    ease: real("ease").notNull().default(2.5),
    lapses: integer("lapses").notNull().default(0),
    lastGrade: integer("last_grade"),
    reviewedAt: integer("reviewed_at"),
  },
  (t) => [
    index("reviews_due_at_idx").on(t.dueAt),
    index("reviews_user_due_at_idx").on(t.userId, t.dueAt),
  ],
);

/**
 * Append-only log of thumbs-up/down signals — one row per click, never updated.
 * A row may point at a chat turn (`conversationId` + `messageId`), at an entry
 * (`entryId`), or at nothing; `kind` is 'up' | 'down' and `createdAt` is epoch ms.
 *
 * None of the reference columns is a foreign key. `conversationId`/`messageId`
 * name Durable Object state that D1 cannot see, and `entryId` is deliberately
 * soft: a cascade would erase the signal when the entry is deleted (the history
 * this table exists to keep), and a restricting FK would break the already
 * shipped DELETE /api/entries/:id. Readers join opportunistically and treat a
 * miss as "that entry is gone".
 */
export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    /** Tenant key (migration 0012) — see the comment on `entries.userId`. */
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    entryId: text("entry_id"),
    kind: text("kind").notNull(),
    comment: text("comment"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("feedback_created_at_idx").on(desc(t.createdAt)),
    index("feedback_user_created_at_idx").on(t.userId, desc(t.createdAt)),
  ],
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
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
export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
