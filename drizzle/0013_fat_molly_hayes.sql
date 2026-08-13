ALTER TABLE `platform_decisions` ADD `strategy_code` text NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_decisions_strategy_status` ON `platform_decisions` (`strategy_code`,`status`);--> statement-breakpoint
ALTER TABLE `trades` ADD `strategy_code` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `community_strategy_id` text;--> statement-breakpoint
CREATE INDEX `idx_trades_strategy_closed` ON `trades` (`strategy_code`,`closed_at`);--> statement-breakpoint
CREATE INDEX `idx_trades_community_strategy_closed` ON `trades` (`community_strategy_id`,`closed_at`);