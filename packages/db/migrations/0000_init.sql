CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`canonical_url` text NOT NULL,
	`title` text,
	`source_domain` text,
	`content_markdown` text,
	`summary` text,
	`takeaway` text,
	`question` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entries_canonical_url_uq` ON `entries` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `entries_status_idx` ON `entries` (`status`);--> statement-breakpoint
CREATE INDEX `entries_created_at_idx` ON `entries` (`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`api_key` text NOT NULL,
	`cf_account_id` text NOT NULL,
	`cf_gateway_id` text NOT NULL,
	`cf_aig_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
