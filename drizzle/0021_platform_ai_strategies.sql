CREATE TABLE IF NOT EXISTS `platform_strategy_subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `strategy_code` text NOT NULL,
  `customer_id` text NOT NULL REFERENCES `users`(`id`),
  `exchange_account_id` text NOT NULL REFERENCES `exchange_accounts`(`id`),
  `capital_pct` real DEFAULT 3 NOT NULL,
  `stop_loss_pct` real DEFAULT 3 NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `risk_consent_at` text,
  `last_risk_check_at` text,
  `risk_check_json` text DEFAULT '{}' NOT NULL,
  `started_at` text,
  `ended_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_platform_strategy_subscription_unique` ON `platform_strategy_subscriptions` (`strategy_code`, `customer_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_platform_strategy_subscriptions_customer` ON `platform_strategy_subscriptions` (`customer_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_platform_strategy_subscriptions_status` ON `platform_strategy_subscriptions` (`status`, `strategy_code`);
