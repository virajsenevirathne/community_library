PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`family_id` text,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text NOT NULL,
	`provider` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notifications_status_check" CHECK(status in ('pending', 'sent', 'failed', 'deferred'))
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "library_id", "family_id", "kind", "dedupe_key", "status", "provider", "error", "created_at") SELECT "id", "library_id", "family_id", "kind", "dedupe_key", "status", "provider", "error", "created_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_key_unique` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notifications_library_idx` ON `notifications` (`library_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_family_idx` ON `notifications` (`family_id`);