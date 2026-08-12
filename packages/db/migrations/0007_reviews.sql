CREATE TABLE `reviews` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'new' NOT NULL,
	`due_at` integer,
	`interval_days` real,
	`ease` real DEFAULT 2.5 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`last_grade` integer,
	`reviewed_at` integer,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reviews_due_at_idx` ON `reviews` (`due_at`);
