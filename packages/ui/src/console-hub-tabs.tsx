"use client";

import Link from "next/link";

import type { DataScope } from "@/lib/rbac";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export type ConsoleHubTab<T extends string> = {
  value: T;
  label: string;
  href: string;
  requiredPermissions?: string[];
};

export function ConsoleHubTabs<T extends string>({
  label,
  active,
  tabs,
  permissions,
}: {
  label: string;
  active: T;
  tabs: ReadonlyArray<ConsoleHubTab<T>>;
  permissions: Record<string, DataScope>;
}) {
  const { t } = useAppLocale();
  const visibleTabs = tabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions));
  if (visibleTabs.length <= 1) return null;
  return <nav className="rc-hub-tabs" aria-label={t(label)}>
    {visibleTabs.map((tab) => <Link key={tab.value} href={tab.href} aria-current={active === tab.value ? "page" : undefined}>{t(tab.label)}</Link>)}
  </nav>;
}
