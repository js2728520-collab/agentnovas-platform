CREATE TABLE `strategy_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `community_strategies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_strategy_favorite_unique` ON `strategy_favorites` (`strategy_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_strategy_favorites_customer` ON `strategy_favorites` (`customer_id`,`created_at`);