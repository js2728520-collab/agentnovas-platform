import type { DataScope } from "../../../lib/rbac.ts";
import type { AppAudience } from "../../../lib/riverton-apps.ts";

export type EffectiveAccessPayload = {
  appId: AppAudience;
  source: "rbac" | "legacy_role";
  user: { id: string; role: string; organizationId: string | null };
  permissions: Record<string, DataScope>;
};

export type ViewerPayload = {
  id: string;
  email: string;
  username?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  locale?: string | null;
  timezone?: string | null;
  role: string;
  organizationId?: string | null;
};

export type ConsoleNavigationItem = {
  href: string;
  label: string;
  description?: string;
  icon: string;
  badge?: string;
  requiredPermissions?: string[];
  /** Stable legacy paths that should keep the owning hub highlighted. */
  activePaths?: string[];
};

/**
 * 分组导航。分组只影响侧边栏的视觉结构，不参与权限判定——
 * 权限仍然逐条落在 item.requiredPermissions 上，整组不可见时才隐藏分组标题。
 */
export type ConsoleNavigationGroup = {
  label: string;
  items: ConsoleNavigationItem[];
};

export type WalletBalance = { currency: string; availableAmount: string; frozenAmount: string; version: string; updatedAt: string };
export type LedgerEntry = { id: string; type: string; sourceType: string; sourceId: string; currency: string; amount: string; createdAt: string };
export type DepositOrder = {
  id: string; platformOrderNo: string; currency: string; network: string | null;
  expectedAmount: string | null; actualAmount: string | null; creditedAmount: string;
  channel: string; provider: string | null; depositAddress: string | null; txId: string | null; confirmations: number;
  requiredConfirmations: number | null; orderStatus: string; fundsStatus: string; riskStatus: string;
  createdAt: string; externalReceivedAt: string | null; creditedAt: string | null;
};
export type NotificationItem = { id: string; category: string; templateKey: string; status: string; payload: Record<string, unknown>; createdAt: string; readAt: string | null };

export type OperationsCustomerPiiCategory = "contact" | "security" | "financial" | "trading";
export type OperationsCustomerPii = {
  contact: { email: string | null; phone: string | null; telegram: string | null; whatsapp: string | null };
  security: { registrationIpAddress: string | null; lastLoginIpAddress: string | null; device: string | null };
  financial: { cumulativeDepositUsdt: string | null; cumulativeSpendUsdt: string | null };
  trading: {
    exchangeAccounts: Array<{ id: string; exchange: string; label: string; environment: string; status: string; canRead: boolean; canTrade: boolean; lastCheckedAt: string | null }>;
    openPositions: Array<{ id: string; exchangeAccountId: string; symbol: string; side: string; quantity: string; entryValueUsdt: string; openedAt: string | null }>;
  };
};
export type OperationsCustomer = {
  customerId: string; email: string; status: string; registeredAt: string; branchId: string | null;
  managerId: string | null; supervisorId: string | null; employeeId: string | null;
  displayName: string | null; contactNote: string | null;
  pii: OperationsCustomerPii;
};
export type OperationsDeposit = {
  id: string; platformOrderNo: string; user: { id: string; email: string | null; phone: string | null; nickname: string };
  currency: string; network: string | null; expectedAmount: string | null; actualAmount: string | null;
  creditedAmount: string; channel: string; sourceAddress: string | null; providerOrderId: string | null;
  txId: string | null; confirmations: number; requiredConfirmations: number | null;
  orderStatus: string; fundsStatus: string; riskStatus: string; createdAt: string;
};
export type OperationsDepositDetail = OperationsDeposit & {
  branchId: string | null; provider: string | null; depositAddress: string | null;
  riskReasons: unknown; ledgerTransactionId: string | null; updatedAt: string;
  externalReceivedAt: string | null; creditedAt: string | null; returnedAt: string | null;
};
export type OperationsActionRequest = {
  id: string; depositOrderId: string; platformOrderNo: string; action: string; status: string; reason: string;
  requestedBy: { userId: string; email: string | null }; customerEmail: string | null;
  currency: string; actualAmount: string | null; requestedAt: string; completedAt: string | null; canReview: boolean;
};
export type OperationsLedgerPosting = {
  id: string; accountId: string; accountType: string; ownerUserId: string | null;
  ownerOrganizationId: string | null; side: "debit" | "credit"; amount: string; currency: string;
};
export type OperationsLedgerTransaction = {
  id: string; type: string; sourceType: string; sourceId: string; currency: string; status: string;
  createdByUserId: string | null; createdAt: string; postings: OperationsLedgerPosting[];
};
export type AccessRole = {
  id: string; applicationId: AppAudience; code: string; name: string; kind: string; status: string;
  isSystem: boolean; permissions: Array<{ permissionKey: string; scope: DataScope }>;
};
export type AccessRoleTemplate = {
  id: string; applicationId: AppAudience; code: string; name: string; status: string;
  currentVersionId: string | null; currentVersion: number | null;
};
export type AccessAssignment = {
  id: string; userId: string; roleId: string; applicationId: AppAudience; status: string;
  roleCode: string; roleName: string; effectiveAt: string; expiresAt: string | null;
};
export type AccessChangeRequest = {
  id: string; applicationId: AppAudience; targetUserId: string | null; targetUserEmail: string | null;
  targetRoleId: string | null; targetRoleName: string | null; changeType: string; status: string; reason: string;
  requestedBy: { userId: string; email: string | null }; requestedAt: string; completedAt: string | null;
  canReview: boolean; decisions: unknown[];
};
export type AuthorizationAuditEvent = {
  id: string; actorUserId: string | null; applicationId: AppAudience; action: string;
  subjectType: string; subjectId: string; createdAt: string;
};
export type MaintenanceModelProfile = {
  id: string; name: string; providerName: string; modelName: string; hasSecret: boolean;
  enabled: boolean; currentRevisionId: string | null; updatedAt: string;
};
export type MaintenanceAgentBinding = {
  role: string; profileId: string; profileName: string; modelName: string; configured: boolean;
  enabled: boolean; revisionNumber: number; updatedAt: string;
};
export type MaintenancePaymentProvider = {
  id: string; provider: string; channel: string; network: string | null;
  configuredStatus: string; effectiveStatus: "disabled" | "incomplete" | "active";
  confirmationThreshold: number | null; hasSecret: boolean; merchantConfigured: boolean;
  gatewayConfigured: boolean; callbackConfigured: boolean; coinMappingConfigured: boolean;
  protocol: string | null; lastTestAt: string | null; lastTestStatus: string | null;
  lastErrorCode: string | null; updatedAt: string;
};
export type MaintenanceEmailStatus = {
  provider: string; configured: boolean; senderDomainVerified: boolean; apiKeyPresent: boolean;
  webhookSecretPresent: boolean; allowlistPresent: boolean; templatesReady: boolean;
  suppressionReady: boolean; workerEnabled: boolean; sendAuthorized: boolean;
  effectiveStatus: "ready" | "configured_not_sent";
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastTestErrorCode: string | null;
  workerHeartbeatAt: string | null;
  contactAddresses: { support: string; security: string; billing: string; operations: string };
  inboundMailboxesVerified: boolean;
};
export type MaintenanceResourcePhase = "ready" | "loading" | "error" | "unknown";
export type MaintenanceResourceDisplayStatus = "ready" | "loading" | "unavailable" | "unknown";
export type MaintenanceResourceSnapshot<T> = {
  data: T | null | undefined;
  loading: boolean;
  error: string | null | undefined;
};
export type MaintenanceWorkerStatus = {
  configured: boolean;
  enabled: boolean;
  liveness: "missing" | "alive" | "stale";
  health: "disabled" | "unconfigured" | "missing" | "stale" | "degraded" | "healthy";
  runtimeStatus: string | null;
  heartbeatAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  currentJobId: string | null;
  commitSha: string | null;
};
export type MaintenanceWorkerHealth = {
  checkedAt: string;
  release: { version: string | null; commitSha: string | null };
  database: {
    status: string;
    pool: { total: number; idle: number; waiting: number };
    migration: { latest: string; checksumRecorded: boolean; commitRecorded: boolean } | null;
  };
  queues: Array<{
    queue: string;
    depth: number;
    oldestAgeSeconds: number | null;
    status: string;
    warningAgeSeconds: number;
    criticalAgeSeconds: number;
  }>;
  paymentWorker: MaintenanceWorkerStatus;
  notificationWorker: MaintenanceWorkerStatus & { resendConfigured: boolean };
  researchWorker: MaintenanceWorkerStatus;
  runtimeWorker: MaintenanceWorkerStatus;
  configurationActivationWorker: MaintenanceWorkerStatus;
  demoExecutionWorker: MaintenanceWorkerStatus & {
    externalWritesEnabled: boolean;
    executionEnabled: boolean;
  };
};
export type MaintenanceTechnicalAuditEvent = {
  id: string; domain: "demo" | "models" | "integrations" | "settings" | "safety" | "releases" | "identity";
  actorUserId: string | null; subject: { type: string; id: string; label: string | null };
  action: string; reason: string | null;
  status: "pending" | "succeeded" | "failed"; errorCode: string | null;
  requestId: string | null; traceId: string | null;
  createdAt: string; completedAt: string | null;
};

export function maintenanceResourcePhase<T>(resource: MaintenanceResourceSnapshot<T>): MaintenanceResourcePhase {
  if (resource.error?.trim()) return "error";
  if (resource.loading) return "loading";
  if (resource.data === null || resource.data === undefined) return "unknown";
  return "ready";
}

export function maintenanceResourceDisplayStatus(phase: MaintenanceResourcePhase): MaintenanceResourceDisplayStatus {
  return phase === "error" ? "unavailable" : phase;
}

export function maintenanceQueueDisplayStatus(
  phase: MaintenanceResourcePhase,
  queues: ReadonlyArray<{ status: string }> | null | undefined,
): Exclude<MaintenanceResourceDisplayStatus, "ready"> | "healthy" | "warning" | "critical" {
  if (phase !== "ready") return maintenanceResourceDisplayStatus(phase) as Exclude<MaintenanceResourceDisplayStatus, "ready">;
  if (!queues?.length) return "unknown";
  if (queues.some((queue) => queue.status === "critical")) return "critical";
  if (queues.some((queue) => queue.status === "warning")) return "warning";
  if (queues.every((queue) => queue.status === "healthy")) return "healthy";
  return "unknown";
}

export function hasAnyPermission(
  permissions: Record<string, DataScope>,
  requiredPermissions: string[] | undefined,
) {
  return !requiredPermissions?.length || requiredPermissions.some((key) => Boolean(permissions[key]));
}

export function visibleNavigation(
  items: ConsoleNavigationItem[],
  permissions: Record<string, DataScope>,
) {
  return items.filter((item) => hasAnyPermission(permissions, item.requiredPermissions));
}

/** 过滤分组导航；整组条目都不可见时，连同分组标题一起丢弃。 */
export function visibleNavigationGroups(
  groups: ConsoleNavigationGroup[],
  permissions: Record<string, DataScope>,
): ConsoleNavigationGroup[] {
  return groups
    .map((group) => ({ label: group.label, items: visibleNavigation(group.items, permissions) }))
    .filter((group) => group.items.length > 0);
}

/** 分组导航展平成条目列表，供面包屑与当前页匹配使用。 */
export function flattenNavigation(groups: ConsoleNavigationGroup[]): ConsoleNavigationItem[] {
  return groups.flatMap((group) => group.items);
}

export function safeNextPath(value: string | null | undefined, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

export function apiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as { error?: string | { message?: string }; message?: string };
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error.message === "string") return value.error.message;
  return typeof value.message === "string" ? value.message : fallback;
}

export function formatDecimal(value: string | number | null | undefined, maximumFractionDigits = 6, locale = "zh-CN") {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toLocaleString(locale, { maximumFractionDigits }) : "0";
}

export function formatDateTime(value: string | null | undefined, locale = "zh-CN") {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale, { hour12: false });
}
