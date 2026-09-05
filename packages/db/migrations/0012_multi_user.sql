-- Multi-user tenancy: `users` + `sessions`, and a `user_id` on every row a
-- person owns (entries, digests, feeds, reviews, feedback, chats, settings).
--
-- The `user_id` columns are ADD COLUMN with `DEFAULT 'owner' NOT NULL`, because
-- this migration lands on a deployed single-user database: every existing row
-- belongs to the deployment's owner, and the default IS the backfill. 'owner'
-- is a placeholder users row inserted below (google_sub NULL); the real Google
-- identity claims it at first login via OWNER_EMAIL (see worker/identity.ts).
-- No REFERENCES clause on any added column — SQLite forbids adding an FK via
-- ALTER TABLE, and rebuilding `entries` would drop the 0001 FTS triggers.
-- Integrity is app-level, the same stance `feedback` already takes.
--
-- The seeded timestamps are a literal (2026-09-05T00:00:00Z, when this
-- migration was written) rather than unixepoch(), the 0005 precedent: a
-- constant cannot behave differently on D1 than in the test harness.
-- INSERT OR IGNORE so re-application is a no-op.
--
-- Uniqueness moves from global to per-user: `entries_canonical_url_uq` becomes
-- (user_id, canonical_url) and `feeds_url_uq` becomes (user_id, url) — two
-- people may save the same link. Both old indexes were standalone CREATE UNIQUE
-- INDEX statements (0000, 0005), so DROP INDEX works; both new ones build
-- cleanly because every existing row shares user_id = 'owner' and was already
-- unique on the second column. `settings` keeps its INTEGER PRIMARY KEY (a
-- rowid alias that self-assigns) and gains UNIQUE(user_id): one BYOK row per
-- user, and the old singleton `id = 1` row simply becomes the owner's.
--
-- `digest_items` and `entry_vectors` deliberately get NO user_id: both hang off
-- a parented row (digests / entries) and are scoped by joining the parent.
--
-- The entries_fts triggers from 0001 name their columns explicitly, so user_id
-- is invisible to the index: an UPDATE touching only it is a no-op re-index —
-- same reasoning as 0009/0010, asserted in packages/db/test/migrations.test.ts.
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text,
	`email` text NOT NULL,
	`name` text,
	`picture` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_uq` ON `users` (`google_sub`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
-- The placeholder owner. email is a sentinel the OWNER_EMAIL claim flow
-- overwrites; `.invalid` is the reserved TLD, so it can never collide with a
-- real Google account's address.
INSERT OR IGNORE INTO `users` (`id`, `google_sub`, `email`, `name`, `picture`, `created_at`, `updated_at`) VALUES
	('owner', NULL, 'owner@placeholder.invalid', 'Owner', NULL, 1788566400000, 1788566400000);
--> statement-breakpoint
ALTER TABLE `entries` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `digests` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `feedback` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
DROP INDEX `entries_canonical_url_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `entries_user_canonical_url_uq` ON `entries` (`user_id`,`canonical_url`);--> statement-breakpoint
DROP INDEX `feeds_url_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_user_url_uq` ON `feeds` (`user_id`,`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `settings_user_uq` ON `settings` (`user_id`);--> statement-breakpoint
CREATE INDEX `entries_user_created_at_idx` ON `entries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chats_user_updated_at_idx` ON `chats` (`user_id`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `digests_user_run_at_idx` ON `digests` (`user_id`,"run_at" desc);--> statement-breakpoint
CREATE INDEX `reviews_user_due_at_idx` ON `reviews` (`user_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `feedback_user_created_at_idx` ON `feedback` (`user_id`,"created_at" desc);
