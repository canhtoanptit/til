-- Library organization (P23): the owner's own marks on an entry, as opposed to
-- everything else on `entries`, which the ingest pipeline wrote.
--
-- Purely ADD COLUMN, because this migration lands on a deployed database. Both
-- flags carry `DEFAULT 0 NOT NULL` so every already-saved entry reads back as
-- "not favorited, not archived" without a backfill statement, and `note` is
-- nullable so "never wrote one" stays distinguishable from "wrote one, then
-- emptied it" — see PATCH /api/entries/:id, where "" clears back to NULL.
--
-- No new index. `favorite`/`archived` are near-constant columns (almost every
-- row is 0), so an index on either is a page of pointers SQLite would ignore;
-- the feed's `WHERE archived = 0 ORDER BY created_at DESC` is already served by
-- `entries_created_at_idx` from 0000.
--
-- The entries_fts triggers from 0001 name their columns explicitly
-- (title, summary, takeaway, tags, content_markdown) rather than using `*`, so
-- these three columns are invisible to the index: an UPDATE that only touches
-- them still fires `entries_au`, which deletes and re-inserts the same terms —
-- a no-op re-index, asserted in packages/db/test/migrations.test.ts.
ALTER TABLE `entries` ADD `favorite` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entries` ADD `archived` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entries` ADD `note` text;
