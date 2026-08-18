CREATE TABLE IF NOT EXISTS `personal_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_personal_agents_user_unique` ON `personal_agents` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_personal_agents_org_status` ON `personal_agents` (`organization_id`,`status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `personal_agent_monthly_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`month` text NOT NULL,
	`performance_usdt` real DEFAULT 0 NOT NULL,
	`commission_rate` real DEFAULT 0.2 NOT NULL,
	`commission_usdt` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `personal_agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_personal_agent_period_unique` ON `personal_agent_monthly_periods` (`agent_id`,`month`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_personal_agent_period_month` ON `personal_agent_monthly_periods` (`month`);
