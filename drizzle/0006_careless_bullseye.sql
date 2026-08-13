ALTER TABLE `notification_deliveries` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notifications_dedupe_unique` ON `notification_deliveries` (`dedupe_key`);