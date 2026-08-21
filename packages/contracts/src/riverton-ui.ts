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
  requiredPermissions?: string[];
};

export type WalletBalance = { currency: string; availableAmount: string; frozenAmount: string; version: string; updatedAt: string };
export type LedgerEntry = { id: string; type: string; sourceType: string; sourceId: string; currency: string; amount: string; createdAt: string };
export type DepositOrder = {
  id: string; platformOrderNo: string; currency: string; network: string | null;
  expectedAmount: string | null; actualAmount: string | null; creditedAmount: string;
  channel: string; depositAddress: string | null; txId: string | null; confirmations: number;
  requiredConfirmations: number | null; orderStatus: string; fundsStatus: string; riskStatus: string;
  createdAt: string; externalReceivedAt: string | null; creditedAt: string | null;
};
export type NotificationItem = { id: string; category: string; templateKey: string; status: string; payload: Record<string, unknown>; createdAt: string; readAt: string | null };

export type OperationsCustomer = {
  customerId: string; email: string; status: string; registeredAt: string; branchId: string | null;
  managerId: string | null; supervisorId: string | null; employeeId: string | null;
  displayName: string | null; contactNote: string | null;
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
  configuredStatus: string; effectiveStatus: "disabled";
  confirmationThreshold: number | null; hasSecret: boolean; updatedAt: string;
};
export type MaintenanceEmailStatus = {
  provider: string; configured: boolean; senderDomainVerified: boolean; apiKeyPresent: boolean;
  lastTestAt: string | null;
};
export type MaintenanceTechnicalAuditEvent = {
  id: string; operation: "control" | "verify"; actorUserId: string;
  account: { id: string; provider: string; label: string };
  action: string; strategyCode: string | null; reason: string;
  status: "pending" | "succeeded" | "failed"; errorCode: string | null;
  createdAt: string; completedAt: string | null;
};

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

export function formatDecimal(value: string | number | null | undefined, maximumFractionDigits = 6) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN", { maximumFractionDigits }) : "0";
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}
