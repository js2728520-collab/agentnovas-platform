CREATE TABLE IF NOT EXISTS `trading_emergency_stops` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`scope_type` text NOT NULL,
	`organization_id` text,
	`active` integer DEFAULT false NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`activated_by_user_id` text,
	`activated_at` text,
	`deactivated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_trading_emergency_scope_unique` ON `trading_emergency_stops` (`scope_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_trading_emergency_active` ON `trading_emergency_stops` (`active`,`scope_type`);
