CREATE TABLE `indexed_files` (
	`path` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`mtime` integer NOT NULL,
	`size` integer NOT NULL,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_hash_idx` ON `indexed_files` (`content_hash`);