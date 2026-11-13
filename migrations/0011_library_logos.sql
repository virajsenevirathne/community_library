CREATE TABLE `library_logos` (
	`library_id` text PRIMARY KEY NOT NULL,
	`image` blob NOT NULL,
	`content_type` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_logos_type_check" CHECK(content_type in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "library_logos_size_check" CHECK(length(image) <= 100000)
);
