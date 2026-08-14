CREATE TABLE `llm_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`owner_user_id` text,
	`provider_name` text DEFAULT 'OpenAI Compatible' NOT NULL,
	`base_url` text NOT NULL,
	`model` text NOT NULL,
	`encrypted_api_key` text DEFAULT '' NOT NULL,
	`masked_api_key` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_by_user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_llm_config_scope_owner_unique` ON `llm_configurations` (`scope`,`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_llm_config_scope_enabled` ON `llm_configurations` (`scope`,`enabled`);--> statement-breakpoint
ALTER TABLE `users` ADD `username` text;--> statement-breakpoint
ALTER TABLE `users` ADD `nickname` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username_unique` ON `users` (`username`);