import type { AppAudience } from "@/lib/riverton-apps";

const CLIENT_ROUTES = new Set(["login", "dashboard", "legal", "account", "membership", "credits", "performance-statements", "paper", "trading-hall", "market", "assistant", "studio", "backtests", "wallet", "notifications", "support"]);
const OPERATIONS_ROUTES = new Set(["login", "account", "customers", "organization", "team", "data-center", "membership-orders", "performance-statements", "credits", "deposits", "ledger", "finance", "approvals", "access"]);
const MAINTENANCE_ROUTES = new Set(["login", "account", "models", "integrations", "health", "safety", "settings", "releases", "access", "audit"]);

export function isRivertonAppRoute(audience: AppAudience, segments: string[]) {
  const root = segments[0];
  if (!root) return segments.length === 0;

  if (audience === "client" && CLIENT_ROUTES.has(root)) {
    if (root === "legal") return segments.length === 2 && segments[1] === "consent";
    if (root === "account") return segments.length === 2 && segments[1] === "security";
    if (root === "wallet") return segments.length === 1 || (segments.length === 2 && segments[1] === "deposits");
    if (root === "membership") return segments.length === 1 || (segments.length === 2 && segments[1] === "orders");
    if (root === "performance-statements") return segments.length <= 2;
    if (root === "paper") return segments.length <= 2;
    if (root === "backtests") return segments.length <= 2;
    if (root === "trading-hall") return segments.length === 1 || (segments.length === 2 && segments[1] === "meeting");
    return segments.length === 1;
  }

  if (audience === "operations" && OPERATIONS_ROUTES.has(root)) {
    if (root === "account") return segments.length === 2 && segments[1] === "security";
    if (["deposits", "membership-orders", "performance-statements"].includes(root)) return segments.length <= 2;
    if (root === "access") return segments.length === 1 || (segments.length === 2 && segments[1] === "audit");
    return segments.length === 1;
  }

  if (audience === "maintenance" && MAINTENANCE_ROUTES.has(root)) {
    if (root === "account") return segments.length === 2 && segments[1] === "security";
    if (root === "integrations") {
      return segments.length === 1
        || (segments.length === 2 && ["email", "payments", "demo-exchanges", "sources"].includes(segments[1]));
    }
    if (root === "settings") return segments.length === 1 || (segments.length === 2 && segments[1] === "disclosures");
    if (root === "access") return segments.length === 1 || (segments.length === 2 && segments[1] === "audit");
    return segments.length === 1;
  }

  return false;
}

export function isRivertonPagePath(audience: AppAudience, pathname: string) {
  if (!pathname.startsWith("/") || pathname.includes("//")) return false;
  const segments = pathname === "/" ? [] : pathname.slice(1).split("/");
  if (segments.some((segment) => !segment)) return false;

  if (segments.length === 1 && segments[0] === "_not-found") return true;
  if (segments.length === 1 && segments[0] === "reset-password") return true;
  if (segments.length === 1 && segments[0] === "verify-email") return audience === "client";
  return isRivertonAppRoute(audience, segments);
}
