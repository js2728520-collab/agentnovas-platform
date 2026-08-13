CREATE TABLE `community_strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`author_user_id` text NOT NULL,
	`name` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`market` text DEFAULT 'crypto' NOT NULL,
	`symbols_json` text DEFAULT '[]' NOT NULL,
	`risk_level` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`conversation_json` text DEFAULT '[]' NOT NULL,
	`specification_json` text DEFAULT '{}' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`submitted_at` text,
	`approved_at` text,
	`published_at` text,
	`rejection_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_community_strategies_status` ON `community_strategies` (`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_community_strategies_author` ON `community_strategies` (`author_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `strategy_author_earnings` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`revenue_event_id` text NOT NULL,
	`fee_rate` real NOT NULL,
	`gross_performance_fee_usdt` real NOT NULL,
	`platform_fee_usdt` real NOT NULL,
	`author_amount_usdt` real NOT NULL,
	`collection_confirmed_at` text NOT NULL,
	`period_month` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`settlement_id` text,
	`paid_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `community_strategies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revenue_event_id`) REFERENCES `revenue_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_strategy_author_earning_revenue` ON `strategy_author_earnings` (`revenue_event_id`);--> statement-breakpoint
CREATE INDEX `idx_strategy_author_earnings_author_period` ON `strategy_author_earnings` (`author_user_id`,`period_month`,`status`);--> statement-breakpoint
CREATE TABLE `strategy_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`risk_consent_at` text,
	`started_at` text,
	`ended_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `community_strategies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_strategy_subscription_unique` ON `strategy_subscriptions` (`strategy_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_strategy_subscriptions_customer` ON `strategy_subscriptions` (`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `strategy_validations` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`source` text DEFAULT 'author_submitted' NOT NULL,
	`period_start` text,
	`period_end` text,
	`sample_size` integer,
	`net_return_pct` real,
	`max_drawdown_pct` real,
	`win_rate_pct` real,
	`metrics_json` text DEFAULT '{}' NOT NULL,
	`evidence_ref` text,
	`reviewed_by` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `community_strategies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_strategy_validations_strategy_kind` ON `strategy_validations` (`strategy_id`,`kind`,`status`);