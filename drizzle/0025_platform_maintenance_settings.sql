CREATE TABLE IF NOT EXISTS `platform_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`section` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`updated_by_user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_platform_settings_section_unique` ON `platform_settings` (`section`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_platform_settings_updated` ON `platform_settings` (`updated_at`);
