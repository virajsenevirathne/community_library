CREATE TABLE `library_webhooks` (
	`library_id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`event` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_status` integer,
	`next_attempt_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "webhook_deliveries_status_check" CHECK(status in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_library_idx` ON `webhook_deliveries` (`library_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);