ALTER TABLE `trades` ADD `close_exchange_order_id` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `execution_venue` text DEFAULT 'internal_demo' NOT NULL;