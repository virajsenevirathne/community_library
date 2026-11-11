PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`family_id` text,
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
INSERT INTO `__new_invitations`("id", "library_id", "family_id", "email", "role", "token_hash", "expires_at", "sent_at", "accepted_at", "created_at") SELECT "id", "library_id", "family_id", "email", "role", "token_hash", "expires_at", "sent_at", "accepted_at", "created_at" FROM `invitations`;--> statement-breakpoint
DROP TABLE `invitations`;--> statement-breakpoint
ALTER TABLE `__new_invitations` RENAME TO `invitations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_library_idx` ON `invitations` (`library_id`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);--> statement-breakpoint
CREATE INDEX `invitations_family_idx` ON `invitations` (`family_id`);--> statement-breakpoint
ALTER TABLE `libraries` ADD `join_nonce` text;