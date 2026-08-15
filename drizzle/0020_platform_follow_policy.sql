CREATE TABLE IF NOT EXISTS `platform_follow_policies` (
  `id` text PRIMARY KEY NOT NULL,
  `allow_follow_without_withdrawal` integer DEFAULT 0 NOT NULL,
  `updated_by_user_id` text REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_platform_follow_policies_updated` ON `platform_follow_policies` (`updated_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `platform_follow_policies` (`id`, `allow_follow_without_withdrawal`) VALUES ('default', 0);
