CREATE TABLE `holds` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`title_id` text NOT NULL,
	`family_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`notified_at` integer,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`title_id`,`library_id`) REFERENCES `titles`(`id`,`library_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`,`library_id`) REFERENCES `families`(`id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holds_title_family_idx` ON `holds` (`library_id`,`title_id`,`family_id`);--> statement-breakpoint
CREATE INDEX `holds_queue_idx` ON `holds` (`library_id`,`title_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `holds_family_idx` ON `holds` (`family_id`);