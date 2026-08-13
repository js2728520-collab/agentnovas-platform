CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verification_token_hash` text,
	`verified_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_channel_unique` ON `notification_channels` (`user_id`,`channel`);--> statement-breakpoint
CREATE INDEX `idx_notification_channel_status` ON `notification_channels` (`status`);