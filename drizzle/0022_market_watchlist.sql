CREATE TABLE IF NOT EXISTS `market_watchlist` (
  `id` text PRIMARY KEY NOT NULL,
  `customer_id` text NOT NULL REFERENCES `users`(`id`),
  `symbol` text NOT NULL,
  `category` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_market_watchlist_customer_symbol_unique` ON `market_watchlist` (`customer_id`, `symbol`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_market_watchlist_customer_created` ON `market_watchlist` (`customer_id`, `created_at`);
