-- Phase 3: kiosk tablets and personal kiosk codes.
-- Only CREATE TABLE and ADD COLUMN on existing tables, so nothing is rebuilt
-- (rebuilding would cascade-delete loans). The ON DELETE clauses on the loan
-- columns are added by hand: drizzle-kit leaves them out of ADD COLUMN.
-- families.kiosk_pin_hash (a placeholder that was never used) is dropped.
CREATE TABLE `kiosk_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kiosk_devices_token_hash_unique` ON `kiosk_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `kiosk_devices_library_idx` ON `kiosk_devices` (`library_id`);--> statement-breakpoint
CREATE INDEX `kiosk_devices_created_by_idx` ON `kiosk_devices` (`created_by`);--> statement-breakpoint
CREATE TABLE `kiosk_people` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`family_id` text NOT NULL,
	`user_id` text,
	`first_name` text,
	`code_hash` text,
	`code_set_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`,`library_id`) REFERENCES `families`(`id`,`library_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "kiosk_people_named_check" CHECK(user_id is not null or first_name is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kiosk_people_code_idx` ON `kiosk_people` (`library_id`,`code_hash`) WHERE code_hash is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `kiosk_people_user_idx` ON `kiosk_people` (`library_id`,`user_id`) WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX `kiosk_people_family_idx` ON `kiosk_people` (`family_id`);--> statement-breakpoint
CREATE INDEX `kiosk_people_user_id_idx` ON `kiosk_people` (`user_id`);--> statement-breakpoint
ALTER TABLE `loans` ADD `kiosk_person_id` text REFERENCES kiosk_people(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `loans` ADD `kiosk_device_id` text REFERENCES kiosk_devices(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `loans_kiosk_person_idx` ON `loans` (`kiosk_person_id`);--> statement-breakpoint
CREATE INDEX `loans_kiosk_device_idx` ON `loans` (`kiosk_device_id`);--> statement-breakpoint
ALTER TABLE `families` DROP COLUMN `kiosk_pin_hash`;