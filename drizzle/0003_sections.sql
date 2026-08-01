CREATE TABLE `sections` (
	`path` text NOT NULL,
	`parent_id` text NOT NULL,
	`section_path` text NOT NULL,
	`text` text NOT NULL,
	`content_hash` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`path`, `parent_id`)
);
--> statement-breakpoint
CREATE INDEX `sections_path_idx` ON `sections` (`path`);
