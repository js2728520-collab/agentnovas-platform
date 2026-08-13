CREATE TABLE `strategy_change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`proposed_changes_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'notice_period' NOT NULL,
	`requested_at` text NOT NULL,
	`notice_ends_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `community_strategies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_strategy_change_status_due` ON `strategy_change_requests` (`status`,`notice_ends_at`);--> statement-breakpoint
CREATE INDEX `idx_strategy_change_strategy` ON `strategy_change_requests` (`strategy_id`,`status`);--> statement-breakpoint
ALTER TABLE `community_strategies` ADD `featured_rank` integer;--> statement-breakpoint
ALTER TABLE `community_strategies` ADD `ranking_score` real DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_community_strategies_featured_unique` ON `community_strategies` (`featured_rank`);--> statement-breakpoint
CREATE INDEX `idx_community_strategies_ranking` ON `community_strategies` (`status`,`ranking_score`);