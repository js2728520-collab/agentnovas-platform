import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  type: text("type", { enum: ["headquarters", "branch", "manager_team", "supervisor_team"] }).notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended", "closed"] }).notNull().default("active"),
  ...timestamps,
}, (t) => [index("idx_organizations_parent").on(t.parentId)]);

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  phone: text("phone"),
  username: text("username"),
  nickname: text("nickname").notNull().default(""),
  avatarUrl: text("avatar_url").notNull().default(""),
  dateOfBirth: text("date_of_birth"),
  gender: text("gender").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: text("email_verified_at"),
  role: text("role", { enum: ["hq_admin", "hq_support", "branch_admin", "manager", "supervisor", "employee", "customer", "finance", "auditor"] }).notNull(),
  organizationId: text("organization_id").references(() => organizations.id),
  reportsToUserId: text("reports_to_user_id"),
  status: text("status", { enum: ["pending", "active", "frozen", "closed"] }).notNull().default("pending"),
  locale: text("locale").notNull().default("zh-CN"),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  ...timestamps,
}, (t) => [uniqueIndex("idx_users_email_unique").on(t.email), uniqueIndex("idx_users_phone_unique").on(t.phone), uniqueIndex("idx_users_username_unique").on(t.username), index("idx_users_org_role").on(t.organizationId, t.role)]);

export const llmConfigurations = sqliteTable("llm_configurations", {
  id: text("id").primaryKey(),
  scope: text("scope", { enum: ["system", "user"] }).notNull(),
  ownerUserId: text("owner_user_id").references(() => users.id),
  providerName: text("provider_name").notNull().default("OpenAI Compatible"),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull().default(""),
  maskedApiKey: text("masked_api_key").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedByUserId: text("updated_by_user_id").references(() => users.id),
  ...timestamps,
}, (t) => [uniqueIndex("idx_llm_config_scope_owner_unique").on(t.scope, t.ownerUserId), index("idx_llm_config_scope_enabled").on(t.scope, t.enabled)]);

export const platformFollowPolicies = sqliteTable("platform_follow_policies", {
  id: text("id").primaryKey(),
  allowFollowWithoutWithdrawal: integer("allow_follow_without_withdrawal", { mode: "boolean" }).notNull().default(false),
  updatedByUserId: text("updated_by_user_id").references(() => users.id),
  ...timestamps,
}, (t) => [index("idx_platform_follow_policies_updated").on(t.updatedAt)]);

export const monthlyTeamTargets = sqliteTable("monthly_team_targets", {
  id: text("id").primaryKey(),
  month: text("month").notNull(),
  branchId: text("branch_id").notNull().references(() => organizations.id),
  assignedByUserId: text("assigned_by_user_id").notNull().references(() => users.id),
  assigneeUserId: text("assignee_user_id").notNull().references(() => users.id),
  newCustomersTarget: integer("new_customers_target").notNull().default(0),
  monthlyCardsTarget: integer("monthly_cards_target").notNull().default(0),
  quarterlyCardsTarget: integer("quarterly_cards_target").notNull().default(0),
  annualCardsTarget: integer("annual_cards_target").notNull().default(0),
  note: text("note").notNull().default(""),
  ...timestamps,
}, (t) => [
  uniqueIndex("idx_monthly_targets_assignee_month").on(t.assigneeUserId, t.month),
  index("idx_monthly_targets_branch_month").on(t.branchId, t.month),
  index("idx_monthly_targets_assigner_month").on(t.assignedByUserId, t.month),
]);

export const targetFollowUps = sqliteTable("target_follow_ups", {
  id: text("id").primaryKey(),
  month: text("month").notNull(),
  branchId: text("branch_id").notNull().references(() => organizations.id),
  subjectUserId: text("subject_user_id").notNull().references(() => users.id),
  alertType: text("alert_type", { enum: ["target_missing", "behind_schedule"] }).notNull(),
  status: text("status", { enum: ["resolved", "reopened"] }).notNull().default("resolved"),
  note: text("note").notNull().default(""),
  handledByUserId: text("handled_by_user_id").notNull().references(() => users.id),
  handledAt: text("handled_at").notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex("idx_target_followup_subject_month_type").on(t.subjectUserId, t.month, t.alertType),
  index("idx_target_followup_branch_month").on(t.branchId, t.month, t.status),
]);

export const authTokens = sqliteTable("auth_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  purpose: text("purpose", { enum: ["verify_email", "reset_password"] }).notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [uniqueIndex("idx_auth_tokens_hash_unique").on(t.tokenHash), index("idx_auth_tokens_user_purpose").on(t.userId, t.purpose)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [uniqueIndex("idx_sessions_token_unique").on(t.tokenHash), index("idx_sessions_user_expiry").on(t.userId, t.expiresAt)]);

export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  kind: text("kind", { enum: ["employee_reusable", "public_pool_single_use"] }).notNull(),
  issuerUserId: text("issuer_user_id").notNull().references(() => users.id),
  ownerEmployeeId: text("owner_employee_id").references(() => users.id),
  organizationId: text("organization_id").references(() => organizations.id),
  status: text("status", { enum: ["active", "used", "disabled"] }).notNull().default("active"),
  usedByUserId: text("used_by_user_id").references(() => users.id),
  usedAt: text("used_at"),
  ...timestamps,
}, (t) => [uniqueIndex("idx_invitations_code_unique").on(t.codeHash), index("idx_invitations_owner_status").on(t.ownerEmployeeId, t.status)]);

export const customerAttributions = sqliteTable("customer_attributions", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull().references(() => users.id),
  source: text("source", { enum: ["employee_invite", "public_pool", "manual_transfer"] }).notNull(),
  status: text("status", { enum: ["public_pool_pending", "review_pending", "active", "rejected", "ended"] }).notNull(),
  branchId: text("branch_id").references(() => organizations.id),
  managerId: text("manager_id").references(() => users.id),
  supervisorId: text("supervisor_id").references(() => users.id),
  employeeId: text("employee_id").references(() => users.id),
  effectiveAt: text("effective_at"),
  endedAt: text("ended_at"),
  reason: text("reason").notNull().default(""),
  approvalId: text("approval_id"),
  ...timestamps,
}, (t) => [index("idx_attribution_customer_effective").on(t.customerId, t.effectiveAt), index("idx_attribution_branch_status").on(t.branchId, t.status)]);

export const customerProfiles = sqliteTable("customer_profiles", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => users.id), displayName: text("display_name").notNull().default(""), contactNote: text("contact_note").notNull().default(""), archivedAt: text("archived_at"), archivedBy: text("archived_by").references(() => users.id), ...timestamps,
}, t => [uniqueIndex("idx_customer_profiles_customer_unique").on(t.customerId)]);

export const customerHandoverNotes = sqliteTable("customer_handover_notes", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => users.id), authorUserId: text("author_user_id").notNull().references(() => users.id), content: text("content").notNull(), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, t => [index("idx_customer_handover_notes_customer_time").on(t.customerId,t.createdAt)]);

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  branchId: text("branch_id").references(() => organizations.id),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] }).notNull().default("pending"),
  requestedBy: text("requested_by").notNull().references(() => users.id),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (t) => [index("idx_approvals_branch_status").on(t.branchId, t.status), index("idx_approvals_subject").on(t.subjectType, t.subjectId)]);

export const approvalDecisions = sqliteTable("approval_decisions", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().references(() => approvalRequests.id),
  reviewerId: text("reviewer_id").notNull().references(() => users.id),
  decision: text("decision", { enum: ["approve", "reject"] }).notNull(),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [uniqueIndex("idx_approval_reviewer_unique").on(t.requestId, t.reviewerId)]);

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => users.id),
  planCode: text("plan_code").notNull(), status: text("status", { enum: ["pending", "active", "grace", "read_only", "expired"] }).notNull(),
  startsAt: text("starts_at"), expiresAt: text("expires_at"), graceEndsAt: text("grace_ends_at"),
  maxExchangeAccounts: integer("max_exchange_accounts").notNull().default(1), maxActiveStrategies: integer("max_active_strategies").notNull().default(1), ...timestamps,
}, (t) => [index("idx_memberships_customer_status").on(t.customerId, t.status)]);

export const exchangeAccounts = sqliteTable("exchange_accounts", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => users.id), exchange: text("exchange").notNull(), label: text("label").notNull(),
  environment: text("environment", { enum: ["demo", "live"] }).notNull().default("demo"), encryptedCredentialRef: text("encrypted_credential_ref").notNull(),
  canRead: integer("can_read", { mode: "boolean" }).notNull().default(false), canTrade: integer("can_trade", { mode: "boolean" }).notNull().default(false),
  withdrawalAuthorized: integer("withdrawal_authorized", { mode: "boolean" }).notNull().default(false), withdrawalCredentialRef: text("withdrawal_credential_ref"),
  status: text("status", { enum: ["pending", "active", "disconnected", "revoked"] }).notNull().default("pending"), lastCheckedAt: text("last_checked_at"), ...timestamps,
}, (t) => [index("idx_exchange_accounts_customer").on(t.customerId, t.status)]);

export const platformDecisions = sqliteTable("platform_decisions", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => users.id), exchangeAccountId: text("exchange_account_id").notNull().references(() => exchangeAccounts.id),
  strategyCode: text("strategy_code").notNull(), strategyVersion: text("strategy_version").notNull(), agentTaskId: text("agent_task_id"), riskApprovalId: text("risk_approval_id"), symbol: text("symbol").notNull(),
  status: text("status", { enum: ["proposed", "risk_rejected", "approved", "executing", "completed", "cancelled"] }).notNull(), evidenceJson: text("evidence_json").notNull().default("{}"), ...timestamps,
}, (t) => [index("idx_decisions_customer_status").on(t.customerId, t.status),index("idx_decisions_strategy_status").on(t.strategyCode,t.status)]);

export const trades = sqliteTable("trades", {
  id: text("id").primaryKey(), exchangeAccountId: text("exchange_account_id").notNull().references(() => exchangeAccounts.id), customerId: text("customer_id").notNull().references(() => users.id),
  decisionId: text("decision_id").references(() => platformDecisions.id), strategyCode: text("strategy_code"), communityStrategyId: text("community_strategy_id"), exchangeOrderId: text("exchange_order_id").notNull(), symbol: text("symbol").notNull(), side: text("side").notNull(),
  closeExchangeOrderId: text("close_exchange_order_id"), executionVenue: text("execution_venue", { enum: ["internal_demo", "okx_demo"] }).notNull().default("internal_demo"),
  origin: text("origin", { enum: ["platform", "customer_manual", "platform_modified_by_customer"] }).notNull(), status: text("status").notNull(),
  openedAt: text("opened_at"), closedAt: text("closed_at"), quantity: real("quantity").notNull(), entryValueUsdt: real("entry_value_usdt").notNull().default(0), exitValueUsdt: real("exit_value_usdt").notNull().default(0),
  feesUsdt: real("fees_usdt").notNull().default(0), fundingUsdt: real("funding_usdt").notNull().default(0), realizedNetPnlUsdt: real("realized_net_pnl_usdt").notNull().default(0),
  lockedFxRate: real("locked_fx_rate"), feeRate: real("fee_rate"), ...timestamps,
}, (t) => [uniqueIndex("idx_trades_exchange_order_unique").on(t.exchangeAccountId, t.exchangeOrderId), index("idx_trades_customer_closed").on(t.customerId, t.closedAt), index("idx_trades_decision").on(t.decisionId),index("idx_trades_strategy_closed").on(t.strategyCode,t.closedAt),index("idx_trades_community_strategy_closed").on(t.communityStrategyId,t.closedAt)]);

export const revenueEvents = sqliteTable("revenue_events", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => users.id), type: text("type", { enum: ["membership", "performance_fee", "adjustment", "refund"] }).notNull(),
  sourceId: text("source_id").notNull(), amountUsdt: real("amount_usdt").notNull(), confirmedAt: text("confirmed_at").notNull(), attributionId: text("attribution_id"),
  attributionStatus: text("attribution_status").notNull(), ruleVersion: text("rule_version").notNull(), status: text("status", { enum: ["confirmed", "reversed"] }).notNull().default("confirmed"), ...timestamps,
}, (t) => [uniqueIndex("idx_revenue_source_unique").on(t.type, t.sourceId), index("idx_revenue_confirmed").on(t.confirmedAt)]);

export const revenueAllocations = sqliteTable("revenue_allocations", {
  id: text("id").primaryKey(), revenueEventId: text("revenue_event_id").notNull().references(() => revenueEvents.id), beneficiaryType: text("beneficiary_type", { enum: ["headquarters", "branch", "manager", "supervisor", "employee"] }).notNull(),
  beneficiaryId: text("beneficiary_id"), rate: real("rate").notNull(), amountUsdt: real("amount_usdt").notNull(), status: text("status", { enum: ["pending", "locked", "approved", "paid", "adjusted"] }).notNull().default("pending"), settlementBatchId: text("settlement_batch_id"), ...timestamps,
}, (t) => [index("idx_allocations_beneficiary_status").on(t.beneficiaryType, t.beneficiaryId, t.status), index("idx_allocations_revenue").on(t.revenueEventId)]);

export const highWaterMarks = sqliteTable("high_water_marks", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => users.id), exchangeAccountId: text("exchange_account_id").notNull().references(() => exchangeAccounts.id),
  realizedNetPnlUsdt: real("realized_net_pnl_usdt").notNull().default(0), chargedProfitUsdt: real("charged_profit_usdt").notNull().default(0), highWaterMarkUsdt: real("high_water_mark_usdt").notNull().default(0), version: integer("version").notNull().default(1), ...timestamps,
}, (t) => [uniqueIndex("idx_hwm_account_unique").on(t.customerId, t.exchangeAccountId)]);

export const settlements = sqliteTable("settlements", {
  id: text("id").primaryKey(), kind: text("kind", { enum: ["customer_weekly_fee", "organization_monthly", "strategy_author_monthly"] }).notNull(), periodStart: text("period_start").notNull(), periodEnd: text("period_end").notNull(),
  beneficiaryId: text("beneficiary_id"), amountUsdt: real("amount_usdt").notNull(), network: text("network", { enum: ["TRC20", "ERC20", "BEP20"] }), status: text("status", { enum: ["draft", "review", "approved", "paid", "overdue", "failed", "carried"] }).notNull().default("draft"),
  approvalId: text("approval_id"), txHash: text("tx_hash"), adjustmentNote: text("adjustment_note"), ...timestamps,
}, (t) => [index("idx_settlements_period_status").on(t.kind, t.periodEnd, t.status)]);

export const payoutProfiles = sqliteTable("payout_profiles", { id:text("id").primaryKey(), ownerUserId:text("owner_user_id").references(()=>users.id), ownerOrganizationId:text("owner_organization_id").references(()=>organizations.id), network:text("network",{enum:["TRC20","ERC20","BEP20"]}).notNull(), address:text("address").notNull(), status:text("status",{enum:["pending_review","active","disabled"]}).notNull().default("pending_review"), approvalId:text("approval_id"), ...timestamps },t=>[index("idx_payout_profile_owner").on(t.ownerUserId,t.ownerOrganizationId,t.status)]);

export const collectionCases = sqliteTable("collection_cases", { id:text("id").primaryKey(), customerId:text("customer_id").notNull().references(()=>users.id), settlementId:text("settlement_id").notNull().references(()=>settlements.id), dueAt:text("due_at").notNull(), graceEndsAt:text("grace_ends_at").notNull(), remindersSent:integer("reminders_sent").notNull().default(0), status:text("status",{enum:["payment_period","grace","trading_stopped","paid","waived"]}).notNull().default("payment_period"), newEntriesAllowed:integer("new_entries_allowed",{mode:"boolean"}).notNull().default(true), paidConfirmedBy:text("paid_confirmed_by").references(()=>users.id), paidConfirmedAt:text("paid_confirmed_at"), ...timestamps },t=>[uniqueIndex("idx_collection_settlement_unique").on(t.settlementId),index("idx_collection_due_status").on(t.status,t.dueAt)]);

export const notificationPreferences = sqliteTable("notification_preferences", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id), channel: text("channel", { enum: ["email", "telegram", "whatsapp", "in_app"] }).notNull(), category: text("category").notNull(),
  mode: text("mode", { enum: ["instant", "digest", "important_only", "disabled"] }).notNull().default("instant"), quietStart: text("quiet_start"), quietEnd: text("quiet_end"), ...timestamps,
}, (t) => [uniqueIndex("idx_notification_pref_unique").on(t.userId, t.channel, t.category)]);

export const notificationChannels = sqliteTable("notification_channels", { id:text("id").primaryKey(), userId:text("user_id").notNull().references(()=>users.id), channel:text("channel",{enum:["email","telegram","whatsapp","in_app"]}).notNull(), destination:text("destination").notNull(), status:text("status",{enum:["pending","verified","disabled"]}).notNull().default("pending"), verificationTokenHash:text("verification_token_hash"), verifiedAt:text("verified_at"), ...timestamps },t=>[uniqueIndex("idx_notification_channel_unique").on(t.userId,t.channel),index("idx_notification_channel_status").on(t.status)]);

export const notificationDeliveries = sqliteTable("notification_deliveries", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id), channel: text("channel").notNull(), category: text("category").notNull(), templateKey: text("template_key").notNull(),
  dedupeKey: text("dedupe_key"), readAt: text("read_at"),
  payloadJson: text("payload_json").notNull().default("{}"), status: text("status", { enum: ["queued", "sent", "delivered", "failed"] }).notNull().default("queued"), attempts: integer("attempts").notNull().default(0), providerMessageId: text("provider_message_id"), lastError: text("last_error"), scheduledAt: text("scheduled_at").notNull(), sentAt: text("sent_at"), ...timestamps,
}, (t) => [index("idx_notifications_status_schedule").on(t.status, t.scheduledAt), uniqueIndex("idx_notifications_dedupe_unique").on(t.dedupeKey)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(), actorUserId: text("actor_user_id").references(() => users.id), action: text("action").notNull(), subjectType: text("subject_type").notNull(), subjectId: text("subject_id").notNull(),
  beforeJson: text("before_json"), afterJson: text("after_json"), ipAddress: text("ip_address"), userAgent: text("user_agent"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [index("idx_audit_subject_time").on(t.subjectType, t.subjectId, t.createdAt), index("idx_audit_actor_time").on(t.actorUserId, t.createdAt)]);

export const communityStrategies = sqliteTable("community_strategies", {
  id: text("id").primaryKey(),
  authorUserId: text("author_user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  summary: text("summary").notNull().default(""),
  market: text("market").notNull().default("crypto"),
  symbolsJson: text("symbols_json").notNull().default("[]"),
  riskLevel: text("risk_level", { enum: ["low", "medium", "high"] }).notNull().default("medium"),
  status: text("status", { enum: ["draft", "testing", "submitted", "approved", "rejected", "published", "paused"] }).notNull().default("draft"),
  publicationMode: text("publication_mode", { enum: ["marketplace", "self_use"] }).notNull().default("marketplace"),
  conversationJson: text("conversation_json").notNull().default("[]"),
  specificationJson: text("specification_json").notNull().default("{}"),
  version: integer("version").notNull().default(1),
  submittedAt: text("submitted_at"), approvedAt: text("approved_at"), publishedAt: text("published_at"), lastFollowedAt: text("last_followed_at"), autoDelistedAt: text("auto_delisted_at"),
  rejectionReason: text("rejection_reason"),
  featuredRank: integer("featured_rank"), rankingScore: real("ranking_score").notNull().default(0),
  ...timestamps,
}, (t) => [index("idx_community_strategies_status").on(t.status, t.publishedAt), index("idx_community_strategies_author").on(t.authorUserId, t.createdAt), uniqueIndex("idx_community_strategies_featured_unique").on(t.featuredRank), index("idx_community_strategies_ranking").on(t.status,t.rankingScore)]);

export const strategyValidations = sqliteTable("strategy_validations", {
  id: text("id").primaryKey(), strategyId: text("strategy_id").notNull().references(() => communityStrategies.id),
  strategyVersion: integer("strategy_version").notNull().default(1),
  kind: text("kind", { enum: ["backtest", "simulation"] }).notNull(),
  status: text("status", { enum: ["queued", "running", "passed", "failed"] }).notNull().default("queued"),
  source: text("source", { enum: ["author_submitted", "platform_engine"] }).notNull().default("author_submitted"),
  periodStart: text("period_start"), periodEnd: text("period_end"), sampleSize: integer("sample_size"),
  netReturnPct: real("net_return_pct"), maxDrawdownPct: real("max_drawdown_pct"), winRatePct: real("win_rate_pct"),
  metricsJson: text("metrics_json").notNull().default("{}"), evidenceRef: text("evidence_ref"),
  reviewedBy: text("reviewed_by").references(() => users.id), completedAt: text("completed_at"), ...timestamps,
}, (t) => [index("idx_strategy_validations_strategy_kind").on(t.strategyId, t.kind, t.status)]);

export const strategySubscriptions = sqliteTable("strategy_subscriptions", {
  id: text("id").primaryKey(), strategyId: text("strategy_id").notNull().references(() => communityStrategies.id),
  customerId: text("customer_id").notNull().references(() => users.id),
  exchangeAccountId: text("exchange_account_id").references(() => exchangeAccounts.id),
  capitalPct: real("capital_pct").notNull().default(5),
  stopLossPct: real("stop_loss_pct").notNull().default(10),
  executionMode: text("execution_mode", { enum: ["proportional", "fixed_risk"] }).notNull().default("proportional"),
  status: text("status", { enum: ["pending", "active", "paused", "ended"] }).notNull().default("pending"),
  riskConsentAt: text("risk_consent_at"), lastRiskCheckAt: text("last_risk_check_at"), riskCheckJson: text("risk_check_json").notNull().default("{}"), startedAt: text("started_at"), endedAt: text("ended_at"), ...timestamps,
}, (t) => [uniqueIndex("idx_strategy_subscription_unique").on(t.strategyId, t.customerId), index("idx_strategy_subscriptions_customer").on(t.customerId, t.status)]);

export const platformStrategySubscriptions = sqliteTable("platform_strategy_subscriptions", {
  id: text("id").primaryKey(),
  strategyCode: text("strategy_code").notNull(),
  customerId: text("customer_id").notNull().references(() => users.id),
  exchangeAccountId: text("exchange_account_id").notNull().references(() => exchangeAccounts.id),
  capitalPct: real("capital_pct").notNull().default(3),
  stopLossPct: real("stop_loss_pct").notNull().default(3),
  status: text("status", { enum: ["active", "paused", "ended"] }).notNull().default("active"),
  riskConsentAt: text("risk_consent_at"),
  lastRiskCheckAt: text("last_risk_check_at"),
  riskCheckJson: text("risk_check_json").notNull().default("{}"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  ...timestamps,
}, (t) => [
  uniqueIndex("idx_platform_strategy_subscription_unique").on(t.strategyCode, t.customerId),
  index("idx_platform_strategy_subscriptions_customer").on(t.customerId, t.status),
  index("idx_platform_strategy_subscriptions_status").on(t.status, t.strategyCode),
]);

export const strategyFavorites = sqliteTable("strategy_favorites", {
  id: text("id").primaryKey(), strategyId: text("strategy_id").notNull().references(() => communityStrategies.id), customerId: text("customer_id").notNull().references(() => users.id), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, t => [uniqueIndex("idx_strategy_favorite_unique").on(t.strategyId,t.customerId),index("idx_strategy_favorites_customer").on(t.customerId,t.createdAt)]);

export const strategyChangeRequests = sqliteTable("strategy_change_requests", {
  id: text("id").primaryKey(), strategyId: text("strategy_id").notNull().references(() => communityStrategies.id),
  authorUserId: text("author_user_id").notNull().references(() => users.id), action: text("action", { enum: ["modify", "delist"] }).notNull(),
  reason: text("reason").notNull(), proposedChangesJson: text("proposed_changes_json").notNull().default("{}"),
  status: text("status", { enum: ["notice_period", "waiting_for_zero_followers", "ready", "completed", "cancelled"] }).notNull().default("notice_period"),
  requestedAt: text("requested_at").notNull(), noticeEndsAt: text("notice_ends_at").notNull(), completedAt: text("completed_at"), ...timestamps,
}, (t) => [index("idx_strategy_change_status_due").on(t.status, t.noticeEndsAt), index("idx_strategy_change_strategy").on(t.strategyId, t.status)]);

export const strategyAuthorEarnings = sqliteTable("strategy_author_earnings", {
  id: text("id").primaryKey(), strategyId: text("strategy_id").notNull().references(() => communityStrategies.id),
  authorUserId: text("author_user_id").notNull().references(() => users.id), revenueEventId: text("revenue_event_id").notNull().references(() => revenueEvents.id),
  feeRate: real("fee_rate").notNull(), grossPerformanceFeeUsdt: real("gross_performance_fee_usdt").notNull(),
  platformFeeUsdt: real("platform_fee_usdt").notNull(), authorAmountUsdt: real("author_amount_usdt").notNull(),
  collectionConfirmedAt: text("collection_confirmed_at").notNull(), periodMonth: text("period_month").notNull(), status: text("status", { enum: ["pending", "locked", "approved", "paid", "adjusted"] }).notNull().default("pending"),
  settlementId: text("settlement_id").references(() => settlements.id), paidAt: text("paid_at"), ...timestamps,
}, (t) => [uniqueIndex("idx_strategy_author_earning_revenue").on(t.revenueEventId), index("idx_strategy_author_earnings_author_period").on(t.authorUserId, t.periodMonth, t.status)]);
