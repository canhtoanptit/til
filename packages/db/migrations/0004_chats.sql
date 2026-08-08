CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chats_updated_at_idx` ON `chats` ("updated_at" desc);
