CREATE TABLE `target_follow_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`branch_id` text NOT NULL,
	`subject_user_id` text NOT NULL,
	`alert_type` text NOT NULL,
	`status` text DEFAULT 'resolved' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`handled_by_user_id` text NOT NULL,
	`handled_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_target_followup_subject_month_type` ON `target_follow_ups` (`subject_user_id`,`month`,`alert_type`);--> statement-breakpoint
CREATE INDEX `idx_target_followup_branch_month` ON `target_follow_ups` (`branch_id`,`month`,`status`);