CREATE TABLE `doc_summaries` (
	`path` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`summary` text NOT NULL
);
