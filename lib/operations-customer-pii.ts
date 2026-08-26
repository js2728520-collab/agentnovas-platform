import { describeClientDevice, maskNetworkAddress } from "./client-device-security.ts";
import { csvSafeCell } from "./deposits.ts";
import { maskOperationsEmail, maskOperationsValue } from "./operations-access.ts";
import type { DataScope } from "./rbac.ts";
import { ResearchApiError } from "./research-errors.ts";

export const CUSTOMER_PII_CATEGORIES = ["contact", "security", "financial", "trading"] as const;
export type CustomerPiiCategory = typeof CUSTOMER_PII_CATEGORIES[number];

export const CUSTOMER_PII_PERMISSION_KEYS = {
  contact: "ops.customers.pii_contact",
  security: "ops.customers.pii_security",
  financial: "ops.customers.pii_financial",
  trading: "ops.customers.pii_trading",
} as const satisfies Record<CustomerPiiCategory, string>;

const SCOPE_RANK: Record<DataScope, number> = {
  SELF: 0,
  DIRECT_REPORTS: 1,
  TEAM_TREE: 2,
  ORGANIZATION: 3,
  ORGANIZATION_SET: 4,
  PLATFORM: 5,
};

export type OperationsExchangeAccountPii = {
  id: string;
  exchange: string;
  label: string;
  environment: string;
  status: string;
  canRead: boolean;
  canTrade: boolean;
  lastCheckedAt: string | null;
};

export type OperationsOpenPositionPii = {
  id: string;
  exchangeAccountId: string;
  symbol: string;
  side: string;
  quantity: string;
  entryValueUsdt: string;
  openedAt: string | null;
};

export type OperationsCustomerPiiRaw = {
  email: string | null;
  phone: string | null;
  telegram: string | null;
  whatsapp: string | null;
  registrationIpAddress: string | null;
  lastLoginIpAddress: string | null;
  lastLoginUserAgent: string | null;
  cumulativeDepositUsdt: string;
  cumulativeSpendUsdt: string;
  exchangeAccounts: OperationsExchangeAccountPii[];
  openPositions: OperationsOpenPositionPii[];
};

function includes(categories: readonly CustomerPiiCategory[], category: CustomerPiiCategory) {
  return categories.includes(category);
}

export function projectOperationsCustomerPii(
  raw: OperationsCustomerPiiRaw,
  revealedCategories: readonly CustomerPiiCategory[],
) {
  const contact = includes(revealedCategories, "contact");
  const security = includes(revealedCategories, "security");
  const financial = includes(revealedCategories, "financial");
  const trading = includes(revealedCategories, "trading");
  return {
    contact: {
      email: contact ? raw.email : maskOperationsEmail(raw.email),
      phone: contact ? raw.phone : maskOperationsValue(raw.phone),
      telegram: contact ? raw.telegram : maskOperationsValue(raw.telegram),
      whatsapp: contact ? raw.whatsapp : maskOperationsValue(raw.whatsapp),
    },
    security: {
      registrationIpAddress: security ? raw.registrationIpAddress : maskNetworkAddress(raw.registrationIpAddress),
      lastLoginIpAddress: security ? raw.lastLoginIpAddress : maskNetworkAddress(raw.lastLoginIpAddress),
      device: security ? describeClientDevice(raw.lastLoginUserAgent) : null,
    },
    financial: {
      cumulativeDepositUsdt: financial ? raw.cumulativeDepositUsdt : null,
      cumulativeSpendUsdt: financial ? raw.cumulativeSpendUsdt : null,
    },
    trading: {
      exchangeAccounts: trading ? raw.exchangeAccounts : [],
      openPositions: trading ? raw.openPositions : [],
    },
  };
}

function normalizedCategories(value: string | null) {
  if (!value?.trim()) return [];
  const categories = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (categories.some((category) => !CUSTOMER_PII_CATEGORIES.includes(category as CustomerPiiCategory))) {
    throw new ResearchApiError("CUSTOMER_PII_CATEGORY_INVALID", "客户敏感字段分类无效", 422);
  }
  return categories as CustomerPiiCategory[];
}

function normalizedReason(value: string | null) {
  let decoded = value ?? "";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    throw new ResearchApiError("CUSTOMER_PII_REASON_INVALID", "客户敏感字段访问原因编码无效", 422);
  }
  const reason = decoded.replace(/\s+/g, " ").trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new ResearchApiError("CUSTOMER_PII_REASON_REQUIRED", "查看客户敏感字段必须填写 8 至 500 字的业务原因", 422);
  }
  return reason;
}

export function customerPiiAccessRequest(
  request: Request,
  permissions: Record<string, unknown>,
): { categories: CustomerPiiCategory[]; reason: string | null } {
  const categories = normalizedCategories(new URL(request.url).searchParams.get("pii"));
  if (!categories.length) return { categories, reason: null };
  for (const category of categories) {
    const permissionKey = CUSTOMER_PII_PERMISSION_KEYS[category];
    if (!permissions[permissionKey]) {
      throw new ResearchApiError("CUSTOMER_PII_FORBIDDEN", "无权查看请求的客户敏感字段", 403, { category, permissionKey });
    }
  }
  return { categories, reason: normalizedReason(request.headers.get("x-customer-pii-reason")) };
}

export function availableCustomerPiiCategories(permissions: Record<string, unknown>) {
  return CUSTOMER_PII_CATEGORIES.filter((category) => Boolean(permissions[CUSTOMER_PII_PERMISSION_KEYS[category]]));
}

export function restrictCustomerPiiScope(input: {
  base: { scope: DataScope; organizationIds: readonly string[] };
  categories: readonly CustomerPiiCategory[];
  grants: Record<string, { scope: DataScope; organizationIds: string[] }>;
  identityOrganizationId: string | null;
}) {
  const selected = [input.base, ...input.categories.map((category) => input.grants[CUSTOMER_PII_PERMISSION_KEYS[category]])];
  if (selected.some((grant) => !grant)) {
    throw new ResearchApiError("CUSTOMER_PII_FORBIDDEN", "客户敏感字段权限范围无效", 403);
  }
  const scope = selected.reduce((narrowest, grant) => SCOPE_RANK[grant.scope] < SCOPE_RANK[narrowest] ? grant.scope : narrowest, input.base.scope);
  const organizationBounds = selected.flatMap((grant) => {
    if (grant.scope === "PLATFORM" || grant.scope === "SELF") return [];
    const ids = grant.organizationIds.length
      ? grant.organizationIds
      : input.identityOrganizationId ? [input.identityOrganizationId] : [];
    return [ids];
  });
  let organizationIds: string[] = [];
  if (organizationBounds.length) {
    organizationIds = [...new Set(organizationBounds[0])];
    for (const bound of organizationBounds.slice(1)) {
      const allowed = new Set(bound);
      organizationIds = organizationIds.filter((id) => allowed.has(id));
    }
    if (!organizationIds.length) {
      throw new ResearchApiError("CUSTOMER_PII_SCOPE_EMPTY", "客户敏感字段权限范围与客户查看范围不相交", 403);
    }
  }
  return { scope, organizationIds: organizationIds.sort() };
}

function redactAuditReason(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/(?<!\d)(?:\+?\d[\d\s()-]{8,}\d)(?!\d)/g, "[PHONE]")
    .replace(/(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, "[IP]")
    .replace(/\b(?:[A-F0-9]{0,4}:){2,}[A-F0-9:]{0,4}\b/gi, "[IP]");
}

export function customerPiiAuditPayload(input: {
  categories: readonly CustomerPiiCategory[];
  reason: string;
  scope: DataScope;
  organizationIds: readonly string[];
  resultCount: number;
  requestId: string | null;
}) {
  return {
    categories: [...input.categories],
    reason: redactAuditReason(input.reason),
    scope: input.scope,
    organizationIds: [...input.organizationIds],
    resultCount: input.resultCount,
    requestId: input.requestId,
  };
}

type CustomerCsvRow = {
  customerId: string;
  status: string;
  registeredAt: string;
  pii: ReturnType<typeof projectOperationsCustomerPii>;
};

function csvCell(value: unknown) {
  return `"${csvSafeCell(value).replaceAll('"', '""')}"`;
}

export function operationsCustomerCsv(rows: readonly CustomerCsvRow[], categories: readonly CustomerPiiCategory[]) {
  const columns: Array<{ heading: string; value: (row: CustomerCsvRow) => unknown }> = [
    { heading: "customer_id", value: (row) => row.customerId },
    { heading: "status", value: (row) => row.status },
    { heading: "registered_at", value: (row) => row.registeredAt },
  ];
  if (includes(categories, "contact")) columns.push(
    { heading: "email", value: (row) => row.pii.contact.email },
    { heading: "phone", value: (row) => row.pii.contact.phone },
    { heading: "telegram", value: (row) => row.pii.contact.telegram },
    { heading: "whatsapp", value: (row) => row.pii.contact.whatsapp },
  );
  if (includes(categories, "security")) columns.push(
    { heading: "registration_ip", value: (row) => row.pii.security.registrationIpAddress },
    { heading: "last_login_ip", value: (row) => row.pii.security.lastLoginIpAddress },
    { heading: "last_login_device", value: (row) => row.pii.security.device },
  );
  if (includes(categories, "financial")) columns.push(
    { heading: "cumulative_deposit_usdt", value: (row) => row.pii.financial.cumulativeDepositUsdt },
    { heading: "cumulative_spend_usdt", value: (row) => row.pii.financial.cumulativeSpendUsdt },
  );
  if (includes(categories, "trading")) columns.push(
    { heading: "exchange_accounts", value: (row) => JSON.stringify(row.pii.trading.exchangeAccounts) },
    { heading: "open_positions", value: (row) => JSON.stringify(row.pii.trading.openPositions) },
  );
  const lines = [columns.map((column) => csvCell(column.heading)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(column.value(row))).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
