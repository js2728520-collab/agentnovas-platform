CREATE TABLE IF NOT EXISTS `ai_conversations` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `title` text DEFAULT '新对话' NOT NULL,
  `purpose` text DEFAULT 'consultation' NOT NULL CHECK (`purpose` IN ('consultation', 'strategy')),
  `status` text DEFAULT 'active' NOT NULL CHECK (`status` IN ('active', 'archived')),
  `last_message_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_conversations_user_status_time` ON `ai_conversations` (`user_id`, `status`, `last_message_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL REFERENCES `ai_conversations`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `role` text NOT NULL CHECK (`role` IN ('user', 'assistant')),
  `content` text NOT NULL,
  `generation_mode` text CHECK (`generation_mode` IN ('ai_provider', 'guided_rules', 'error')),
  `provider_name` text,
  `model` text,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_messages_conversation_time` ON `ai_messages` (`conversation_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_messages_user_role_time` ON `ai_messages` (`user_id`, `role`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_usage_daily` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `usage_date` text NOT NULL,
  `request_count` integer DEFAULT 0 NOT NULL CHECK (`request_count` >= 0),
  `input_chars` integer DEFAULT 0 NOT NULL CHECK (`input_chars` >= 0),
  `output_chars` integer DEFAULT 0 NOT NULL CHECK (`output_chars` >= 0),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_ai_usage_user_date_unique` ON `ai_usage_daily` (`user_id`, `usage_date`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `strategy_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `strategy_id` text NOT NULL REFERENCES `community_strategies`(`id`),
  `version` integer NOT NULL CHECK (`version` > 0),
  `name` text DEFAULT '' NOT NULL,
  `summary` text DEFAULT '' NOT NULL,
  `specification_json` text NOT NULL,
  `conversation_id` text REFERENCES `ai_conversations`(`id`),
  `source` text DEFAULT 'manual' NOT NULL CHECK (`source` IN ('manual', 'ai_provider', 'guided_rules')),
  `created_by_user_id` text NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_strategy_versions_strategy_version_unique` ON `strategy_versions` (`strategy_id`, `version`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_versions_conversation` ON `strategy_versions` (`conversation_id`, `created_at`);
