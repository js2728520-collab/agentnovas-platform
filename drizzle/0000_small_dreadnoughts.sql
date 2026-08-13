CREATE TABLE `approval_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`decision` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `approval_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approval_reviewer_unique` ON `approval_decisions` (`request_id`,`reviewer_id`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`branch_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`branch_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_approvals_branch_status` ON `approval_requests` (`branch_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_approvals_subject` ON `approval_requests` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`ip_address` text,
	`user_agent` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_subject_time` ON `audit_logs` (`subject_type`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor_time` ON `audit_logs` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `customer_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`branch_id` text,
	`manager_id` text,
	`supervisor_id` text,
	`employee_id` text,
	`effective_at` text,
	`ended_at` text,
	`reason` text DEFAULT '' NOT NULL,
	`approval_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`branch_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`manager_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supervisor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_attribution_customer_effective` ON `customer_attributions` (`customer_id`,`effective_at`);--> statement-breakpoint
CREATE INDEX `idx_attribution_branch_status` ON `customer_attributions` (`branch_id`,`status`);--> statement-breakpoint
CREATE TABLE `exchange_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`exchange` text NOT NULL,
	`label` text NOT NULL,
	`environment` text DEFAULT 'demo' NOT NULL,
	`encrypted_credential_ref` text NOT NULL,
	`can_read` integer DEFAULT false NOT NULL,
	`can_trade` integer DEFAULT false NOT NULL,
	`withdrawal_authorized` integer DEFAULT false NOT NULL,
	`withdrawal_credential_ref` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_checked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_exchange_accounts_customer` ON `exchange_accounts` (`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `high_water_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`exchange_account_id` text NOT NULL,
	`realized_net_pnl_usdt` real DEFAULT 0 NOT NULL,
	`charged_profit_usdt` real DEFAULT 0 NOT NULL,
	`high_water_mark_usdt` real DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exchange_account_id`) REFERENCES `exchange_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hwm_account_unique` ON `high_water_marks` (`customer_id`,`exchange_account_id`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`kind` text NOT NULL,
	`issuer_user_id` text NOT NULL,
	`owner_employee_id` text,
	`organization_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`used_by_user_id` text,
	`used_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`issuer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_employee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_invitations_code_unique` ON `invitations` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_invitations_owner_status` ON `invitations` (`owner_employee_id`,`status`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`plan_code` text NOT NULL,
	`status` text NOT NULL,
	`starts_at` text,
	`expires_at` text,
	`grace_ends_at` text,
	`max_exchange_accounts` integer DEFAULT 1 NOT NULL,
	`max_active_strategies` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_memberships_customer_status` ON `memberships` (`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`category` text NOT NULL,
	`template_key` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`provider_message_id` text,
	`last_error` text,
	`scheduled_at` text NOT NULL,
	`sent_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_status_schedule` ON `notification_deliveries` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`category` text NOT NULL,
	`mode` text DEFAULT 'instant' NOT NULL,
	`quiet_start` text,
	`quiet_end` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_pref_unique` ON `notification_preferences` (`user_id`,`channel`,`category`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_organizations_parent` ON `organizations` (`parent_id`);--> statement-breakpoint
CREATE TABLE `platform_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`exchange_account_id` text NOT NULL,
	`strategy_version` text NOT NULL,
	`agent_task_id` text,
	`risk_approval_id` text,
	`symbol` text NOT NULL,
	`status` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exchange_account_id`) REFERENCES `exchange_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_decisions_customer_status` ON `platform_decisions` (`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `revenue_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`revenue_event_id` text NOT NULL,
	`beneficiary_type` text NOT NULL,
	`beneficiary_id` text,
	`rate` real NOT NULL,
	`amount_usdt` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`settlement_batch_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`revenue_event_id`) REFERENCES `revenue_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_allocations_beneficiary_status` ON `revenue_allocations` (`beneficiary_type`,`beneficiary_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_allocations_revenue` ON `revenue_allocations` (`revenue_event_id`);--> statement-breakpoint
CREATE TABLE `revenue_events` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`type` text NOT NULL,
	`source_id` text NOT NULL,
	`amount_usdt` real NOT NULL,
	`confirmed_at` text NOT NULL,
	`attribution_id` text,
	`attribution_status` text NOT NULL,
	`rule_version` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_revenue_source_unique` ON `revenue_events` (`type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_revenue_confirmed` ON `revenue_events` (`confirmed_at`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`beneficiary_id` text,
	`amount_usdt` real NOT NULL,
	`network` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`approval_id` text,
	`tx_hash` text,
	`adjustment_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_settlements_period_status` ON `settlements` (`kind`,`period_end`,`status`);--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`exchange_account_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`decision_id` text,
	`exchange_order_id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`origin` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` text,
	`closed_at` text,
	`quantity` real NOT NULL,
	`entry_value_usdt` real DEFAULT 0 NOT NULL,
	`exit_value_usdt` real DEFAULT 0 NOT NULL,
	`fees_usdt` real DEFAULT 0 NOT NULL,
	`funding_usdt` real DEFAULT 0 NOT NULL,
	`realized_net_pnl_usdt` real DEFAULT 0 NOT NULL,
	`locked_fx_rate` real,
	`fee_rate` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`exchange_account_id`) REFERENCES `exchange_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `platform_decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_trades_exchange_order_unique` ON `trades` (`exchange_account_id`,`exchange_order_id`);--> statement-breakpoint
CREATE INDEX `idx_trades_customer_closed` ON `trades` (`customer_id`,`closed_at`);--> statement-breakpoint
CREATE INDEX `idx_trades_decision` ON `trades` (`decision_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`email_verified_at` text,
	`role` text NOT NULL,
	`organization_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`locale` text DEFAULT 'zh-CN' NOT NULL,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_org_role` ON `users` (`organization_id`,`role`);