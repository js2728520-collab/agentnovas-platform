import type { ConsoleNavigationItem } from "@/packages/contracts/src/riverton-ui";

export type ClientSection = "dashboard" | "trading" | "strategies" | "market" | "assistant" | "account-center" | "settings" | "support";
export type TradingTab = "hall" | "portfolios" | "records";
export type StrategyTab = "research" | "backtests";
export type AccountCenterTab = "membership" | "credits" | "wallet" | "deposit" | "statements";
export type SettingsTab = "profile" | "appearance" | "security" | "notifications";

export const clientPrimaryNavigation = [
  { href: "/dashboard", label: "数据看板", icon: "dashboard" },
  { href: "/trading", label: "交易中心", icon: "hall", requiredPermissions: ["client.paper.view"] },
  { href: "/strategies", label: "策略中心", icon: "lab", requiredPermissions: ["client.paper.view"] },
  { href: "/market", label: "行情", icon: "chart" },
  { href: "/assistant", label: "AI 助手", icon: "activity" },
] satisfies ConsoleNavigationItem[];

const tradingTabs = new Set<TradingTab>(["hall", "portfolios", "records"]);
const strategyTabs = new Set<StrategyTab>(["research", "backtests"]);
const accountCenterTabs = new Set<AccountCenterTab>(["membership", "credits", "wallet", "deposit", "statements"]);
const settingsTabs = new Set<SettingsTab>(["profile", "appearance", "security", "notifications"]);

function isOneOf<T extends string>(value: string | null | undefined, allowed: Set<T>): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

export function resolveClientSection(pathname: string): ClientSection {
  const root = pathname.split("?")[0]?.split("/").filter(Boolean)[0] ?? "dashboard";
  if (["trading", "trading-hall", "paper", "work-records"].includes(root)) return "trading";
  if (["strategies", "studio", "backtests"].includes(root)) return "strategies";
  if (["account-center", "membership", "credits", "wallet", "performance-statements"].includes(root)) return "account-center";
  if (["settings", "account", "legal"].includes(root)) return "settings";
  if (root === "market" || root === "assistant" || root === "support") return root;
  return "dashboard";
}

export function resolveTradingTab(requested: string | null | undefined, legacyRoot?: string): TradingTab {
  if (isOneOf(requested, tradingTabs)) return requested;
  if (legacyRoot === "paper") return "portfolios";
  if (legacyRoot === "work-records") return "records";
  return "hall";
}

export function resolveStrategyTab(requested: string | null | undefined, legacyRoot?: string): StrategyTab {
  if (isOneOf(requested, strategyTabs)) return requested;
  return legacyRoot === "backtests" ? "backtests" : "research";
}

export function resolveAccountCenterTab(
  requested: string | null | undefined,
  legacyRoot?: string,
  legacySegments: string[] = [],
  availableTabs: Iterable<AccountCenterTab> = [],
): AccountCenterTab {
  if (isOneOf(requested, accountCenterTabs)) return requested;
  if (legacyRoot === "credits") return "credits";
  if (legacyRoot === "wallet") return legacySegments[0] === "deposits" ? "deposit" : "wallet";
  if (legacyRoot === "performance-statements") return "statements";
  if (legacyRoot === "account-center") {
    const available = new Set(availableTabs);
    return (["membership", "credits", "wallet", "deposit", "statements"] as AccountCenterTab[])
      .find((tab) => available.has(tab)) ?? "membership";
  }
  return "membership";
}

export function resolveSettingsTab(requested: string | null | undefined, legacyRoot?: string, legacySegments: string[] = []): SettingsTab {
  if (isOneOf(requested, settingsTabs)) return requested;
  if (legacyRoot === "account") return legacySegments[0] === "profile" ? "profile" : "security";
  return "profile";
}
