CREATE TABLE `entry_vectors` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`embed_model` text NOT NULL,
	`dims` integer NOT NULL,
	`values` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
