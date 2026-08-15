ALTER TABLE `users` ADD `phone` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `date_of_birth` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `gender` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_phone_unique` ON `users` (`phone`);
