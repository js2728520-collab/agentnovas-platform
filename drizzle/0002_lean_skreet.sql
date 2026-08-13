CREATE TABLE `collection_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`settlement_id` text NOT NULL,
	`due_at` text NOT NULL,
	`grace_ends_at` text NOT NULL,
	`reminders_sent` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'payment_period' NOT NULL,
	`new_entries_allowed` integer DEFAULT true NOT NULL,
	`paid_confirmed_by` text,
	`paid_confirmed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_collection_settlement_unique` ON `collection_cases` (`settlement_id`);--> statement-breakpoint
CREATE INDEX `idx_collection_due_status` ON `collection_cases` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `payout_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_organization_id` text,
	`network` text NOT NULL,
	`address` text NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`approval_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_payout_profile_owner` ON `payout_profiles` (`owner_user_id`,`owner_organization_id`,`status`);