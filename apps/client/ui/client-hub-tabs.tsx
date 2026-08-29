"use client";

import Link from "next/link";

import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import styles from "./client-hub-tabs.module.css";

export type ClientHubTab<T extends string> = { value: T; label: string; href: string; visible?: boolean };

export function ClientHubTabs<T extends string>({ label, active, tabs }: { label: string; active: T; tabs: Array<ClientHubTab<T>> }) {
  const { t } = useAppLocale();
  return <nav className={styles.tabs} aria-label={t(label)}>
    {tabs.filter((tab) => tab.visible !== false).map((tab) => <Link key={tab.value} href={tab.href} aria-current={active === tab.value ? "page" : undefined}>{t(tab.label)}</Link>)}
  </nav>;
}
