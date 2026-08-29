import type { UserAppLocale } from "@/lib/user-app-preference";

export type ReadinessCheck = {
  key: string;
  label: string;
  status: "ready" | "missing" | "partial";
  severity: "blocking" | "warning" | "info";
  detail: string;
  action?: string | null;
};

const englishLabels: Record<string, string> = {
  database_roles: "Database roles",
  administrator: "Initial administrator",
  legal_disclosures: "Seven commercial disclosures",
  membership_plans: "Membership plans",
  model_bindings: "Agent model bindings",
  organizations: "Organization structure",
  deposit_provider: "Deposit provider",
};

const englishActions: Record<string, string> = {
  database_roles: "Apply deploy/postgres/least-privilege-roles.sql, then run the postgres-role-policy check.",
  administrator: "Set ALLOW_INTERNAL_BOOTSTRAP=1, then run scripts/bootstrap-internal-admin.mjs.",
  legal_disclosures: "Submit every item under Maintenance → Platform configuration → Versioned disclosures, then have a second operator approve it. Customers cannot place an order until all seven are published.",
  membership_plans: "Check commercial_plan_versions and confirm migration 0059 has been applied.",
  model_bindings: "In Models, create and test a profile, then bind every role. Unbound roles silently omit that analysis stage.",
  organizations: "Creating the first branch_admin creates a branch. Branch-level performance remains empty while only headquarters exists.",
  deposit_provider: "Configure the UDUN credentials and enable the provider. Enable the Nginx callback location in the same change or deposits can arrive without a ledger callback.",
};

function englishDetail(check: ReadinessCheck): string {
  const numbers = check.detail.match(/\d+/g) ?? [];
  if (check.key === "database_roles") return check.status === "ready"
    ? `${numbers[0] ?? "10"} database roles present`
    : `Missing: ${check.detail.replace(/^缺少\s*/, "").replaceAll("、", ", ")}`;
  if (check.key === "administrator") return check.status === "ready"
    ? `${numbers[0] ?? "1"} active headquarters administrator(s)`
    : "Not created";
  if (check.key === "legal_disclosures") return `Published ${numbers[0] ?? "0"}/7`;
  if (check.key === "membership_plans") {
    if (!numbers.length) return "No active plans";
    if (check.status === "ready") return `${numbers[0]} plan(s), priced in USDT`;
    const currency = check.detail.match(/币种为\s*([^—]+)/)?.[1]?.trim() ?? "an incompatible currency";
    return `${numbers[0]} plan(s), priced in ${currency}; customer USDT balances cannot pay for them.`;
  }
  if (check.key === "model_bindings") return `${numbers[0] ?? "0"}/${numbers[1] ?? "0"} roles bound (${numbers[2] ?? "0"} research agents + ${numbers[3] ?? "0"} runtime explanation roles)`;
  if (check.key === "organizations") return check.status === "ready"
    ? `${numbers[0] ?? "0"} branch(es)`
    : "Headquarters only; no branches";
  if (check.key === "deposit_provider") return check.status === "ready"
    ? `${numbers[0] ?? "0"} enabled provider(s)`
    : "Disabled; customers cannot deposit";
  return check.detail;
}

export function readinessCopy(check: ReadinessCheck, locale: UserAppLocale) {
  if (locale === "zh-CN") return { label: check.label, detail: check.detail, action: check.action ?? null };
  return {
    label: englishLabels[check.key] ?? check.label,
    detail: englishDetail(check),
    action: check.action ? englishActions[check.key] ?? check.action : null,
  };
}
