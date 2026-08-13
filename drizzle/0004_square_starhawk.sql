CREATE TABLE `monthly_team_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`branch_id` text NOT NULL,
	`assigned_by_user_id` text NOT NULL,
	`assignee_user_id` text NOT NULL,
	`new_customers_target` integer DEFAULT 0 NOT NULL,
	`monthly_cards_target` integer DEFAULT 0 NOT NULL,
	`quarterly_cards_target` integer DEFAULT 0 NOT NULL,
	`annual_cards_target` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_monthly_targets_assignee_month` ON `monthly_team_targets` (`assignee_user_id`,`month`);--> statement-breakpoint
CREATE INDEX `idx_monthly_targets_branch_month` ON `monthly_team_targets` (`branch_id`,`month`);--> statement-breakpoint
CREATE INDEX `idx_monthly_targets_assigner_month` ON `monthly_team_targets` (`assigned_by_user_id`,`month`);--> statement-breakpoint
ALTER TABLE `users` ADD `reports_to_user_id` text;