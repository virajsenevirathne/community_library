CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `copies` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`title_id` text NOT NULL,
	`short_code` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`shelf` text,
	`note` text,
	`found_at` integer,
	`found_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`found_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`title_id`,`library_id`) REFERENCES `titles`(`id`,`library_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "copies_status_check" CHECK(status in ('available', 'lost', 'damaged', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `copies_short_code_unique` ON `copies` (`short_code`);--> statement-breakpoint
CREATE INDEX `copies_library_idx` ON `copies` (`library_id`);--> statement-breakpoint
CREATE INDEX `copies_title_idx` ON `copies` (`title_id`);--> statement-breakpoint
CREATE INDEX `copies_found_by_idx` ON `copies` (`found_by`);--> statement-breakpoint
CREATE UNIQUE INDEX `copies_id_library_idx` ON `copies` (`id`,`library_id`);--> statement-breakpoint
CREATE TABLE `email_quota` (
	`provider` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`provider`, `day`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`actor_user_id` text,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "events_payload_json" CHECK(json_valid(payload))
);
--> statement-breakpoint
CREATE INDEX `events_library_idx` ON `events` (`library_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_actor_idx` ON `events` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`name` text NOT NULL,
	`kiosk_pin_hash` text,
	`status` text DEFAULT 'active' NOT NULL,
	`nudges_off` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "families_status_check" CHECK(status in ('active', 'pending', 'deactivated'))
);
--> statement-breakpoint
CREATE INDEX `families_library_idx` ON `families` (`library_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `families_id_library_idx` ON `families` (`id`,`library_id`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`family_id` text NOT NULL,
	`email` text,
	`role` text DEFAULT 'member' NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`sent_at` integer,
	`accepted_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`,`library_id`) REFERENCES `families`(`id`,`library_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitations_role_check" CHECK(role in ('admin', 'staff', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_library_idx` ON `invitations` (`library_id`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);--> statement-breakpoint
CREATE INDEX `invitations_family_idx` ON `invitations` (`family_id`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`name` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `libraries` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`join_token_hash` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "libraries_settings_json" CHECK(json_valid(settings))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_slug_unique` ON `libraries` (`slug`);--> statement-breakpoint
CREATE TABLE `loans` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`copy_id` text NOT NULL,
	`family_id` text,
	`borrowed_by` text,
	`borrowed_at` integer NOT NULL,
	`due_on` text NOT NULL,
	`returned_at` integer,
	`returned_by` text,
	`outcome` text,
	`extended_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`borrowed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`returned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`copy_id`,`library_id`) REFERENCES `copies`(`id`,`library_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`,`library_id`) REFERENCES `families`(`id`,`library_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "loans_outcome_check" CHECK(outcome is null or outcome in ('returned', 'lost', 'damaged', 'found')),
	CONSTRAINT "loans_closed_check" CHECK((returned_at is null) = (outcome is null)),
	CONSTRAINT "loans_due_on_check" CHECK(due_on glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "loans_extended_check" CHECK(extended_count >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loans_one_open_per_copy_idx` ON `loans` (`copy_id`) WHERE returned_at is null;--> statement-breakpoint
CREATE INDEX `loans_copy_history_idx` ON `loans` (`copy_id`,`borrowed_at`);--> statement-breakpoint
CREATE INDEX `loans_family_open_idx` ON `loans` (`family_id`,`returned_at`);--> statement-breakpoint
CREATE INDEX `loans_library_open_idx` ON `loans` (`library_id`,`returned_at`,`due_on`);--> statement-breakpoint
CREATE INDEX `loans_borrowed_by_idx` ON `loans` (`borrowed_by`);--> statement-breakpoint
CREATE INDEX `loans_returned_by_idx` ON `loans` (`returned_by`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`family_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`,`library_id`) REFERENCES `families`(`id`,`library_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memberships_role_check" CHECK(role in ('admin', 'staff', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_library_user_idx` ON `memberships` (`library_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_family_idx` ON `memberships` (`family_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
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
	CONSTRAINT "notifications_status_check" CHECK(status in ('sent', 'failed', 'deferred'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_key_unique` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notifications_library_idx` ON `notifications` (`library_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_family_idx` ON `notifications` (`family_id`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_idx` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `titles` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`isbn` text,
	`title` text NOT NULL,
	`authors` text DEFAULT '' NOT NULL,
	`cover_url` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `titles_library_idx` ON `titles` (`library_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `titles_library_isbn_idx` ON `titles` (`library_id`,`isbn`) WHERE isbn is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `titles_id_library_idx` ON `titles` (`id`,`library_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);