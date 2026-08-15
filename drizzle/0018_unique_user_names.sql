CREATE UNIQUE INDEX `idx_users_username_ci_unique` ON `users` (lower(`username`)) WHERE `username` IS NOT NULL AND `username` <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_nickname_ci_unique` ON `users` (lower(`nickname`)) WHERE `nickname` <> '';
