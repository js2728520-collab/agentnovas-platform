ALTER TABLE `strategy_subscriptions` ADD `exchange_account_id` text REFERENCES exchange_accounts(id);--> statement-breakpoint
ALTER TABLE `strategy_subscriptions` ADD `capital_pct` real DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_subscriptions` ADD `stop_loss_pct` real DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_subscriptions` ADD `execution_mode` text DEFAULT 'proportional' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_subscriptions` ADD `last_risk_check_at` text;--> statement-breakpoint
ALTER TABLE `strategy_subscriptions` ADD `risk_check_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_validations` ADD `strategy_version` integer DEFAULT 1 NOT NULL;