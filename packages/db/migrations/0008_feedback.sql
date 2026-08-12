-- An append-only log of thumbs-up/down signals. Every reference column is
-- nullable and unconstrained on purpose: one row may point at a chat turn
-- (conversation_id + message_id), at an entry (entry_id), or at nothing but
-- itself. Nothing in the app reads this table yet — it accumulates so the
-- retrieval/answer quality work has real online signal to look at later.
--
-- WHY no foreign key on entry_id, unlike reviews/entry_vectors:
--   * ON DELETE cascade would silently erase the signal when the entry it was
--     about is deleted, which is exactly the history this table exists to keep.
--   * no action / restrict would make DELETE /api/entries/:id fail with a
--     constraint error as soon as any feedback exists — changing the behaviour
--     of an endpoint that already ships.
--   * SET NULL keeps the row but throws away its subject.
-- So entry_id (like conversation_id and message_id, which name Durable Object
-- state that D1 cannot see at all) is a soft reference: a reader joins it when
-- the row still exists and treats a miss as "that entry is gone".
--
-- kind is 'up' | 'down', enforced by the zod body schema on POST /api/feedback
-- rather than a CHECK constraint, matching how entries.status and digests.status
-- are handled.
CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`entry_id` text,
	`kind` text NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_created_at_idx` ON `feedback` ("created_at" desc);
