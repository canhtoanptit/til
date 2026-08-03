CREATE TABLE `digest_items` (
	`id` text PRIMARY KEY NOT NULL,
	`digest_id` text NOT NULL,
	`rank` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`source_name` text NOT NULL,
	`source_domain` text NOT NULL,
	`score` real NOT NULL,
	`why` text,
	`evidence` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`digest_id`) REFERENCES `digests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `digest_items_digest_id_rank_idx` ON `digest_items` (`digest_id`,`rank`);--> statement-breakpoint
CREATE TABLE `digests` (
	`id` text PRIMARY KEY NOT NULL,
	`run_at` integer NOT NULL,
	`window_days` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`title` text,
	`intro` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `digests_run_at_idx` ON `digests` ("run_at" desc);