-- Phase 2: the platform owner, and paused libraries.
-- Plain ADD COLUMN on purpose: rebuilding `libraries` (drop + copy) would
-- cascade-delete every library's books, loans and families.
CREATE TABLE `platform_admins` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `libraries` ADD `status` text DEFAULT 'active' NOT NULL CONSTRAINT "libraries_status_check" CHECK(status in ('active', 'paused'));
--> statement-breakpoint
ALTER TABLE `libraries` ADD `plan` text DEFAULT 'free' NOT NULL;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `terms_accepted_at` integer;
