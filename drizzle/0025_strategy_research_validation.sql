ALTER TABLE `community_strategies` ADD `validation_label` text NOT NULL DEFAULT 'UNVERIFIED';
--> statement-breakpoint
ALTER TABLE `community_strategies` ADD `research_run_id` text;
--> statement-breakpoint
ALTER TABLE `community_strategies` ADD `research_candidate_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_community_strategies_research_candidate_unique` ON `community_strategies` (`research_candidate_id`);
