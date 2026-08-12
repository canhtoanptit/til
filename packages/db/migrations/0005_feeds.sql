-- The owner's RSS/Atom sources for the digest. Seeded with what used to be
-- hardcoded in core's DEFAULT_RSS_FEEDS, so an existing deployment keeps the
-- exact same three sources after this migration is applied.
--
-- The seeded timestamps are a literal (2026-08-12T00:00:00Z, when this migration
-- was written) rather than unixepoch(): a constant cannot behave differently on
-- D1 than it does in the test harness. INSERT OR IGNORE so a re-application over
-- a database that already has these rows is a no-op instead of a hard failure.
CREATE TABLE `feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_url_uq` ON `feeds` (`url`);--> statement-breakpoint
CREATE INDEX `feeds_enabled_idx` ON `feeds` (`enabled`);--> statement-breakpoint
INSERT OR IGNORE INTO `feeds` (`id`, `url`, `title`, `enabled`, `created_at`, `updated_at`) VALUES
	('feed-blog-cloudflare-com', 'https://blog.cloudflare.com/rss/', 'The Cloudflare Blog', 1, 1786492800000, 1786492800000),
	('feed-jvns-ca', 'https://jvns.ca/atom.xml', 'Julia Evans', 1, 1786492800000, 1786492800000),
	('feed-simonwillison-net', 'https://simonwillison.net/atom/everything/', 'Simon Willison', 1, 1786492800000, 1786492800000);
