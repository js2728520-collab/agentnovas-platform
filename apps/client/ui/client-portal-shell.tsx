"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  visibleNavigation,
  type ConsoleNavigationItem,
  type EffectiveAccessPayload,
  type ViewerPayload,
} from "@/packages/contracts/src/riverton-ui";

import styles from "./client-portal-shell.module.css";

const primaryNavigation: ConsoleNavigationItem[] = [
  { href: "/dashboard", label: "交易总览", icon: "⌂" },
  { href: "/trading-hall", label: "交易大厅", icon: "◈", requiredPermissions: ["client.paper.view"] },
  { href: "/paper", label: "模拟组合", icon: "▥", requiredPermissions: ["client.paper.view"] },
  { href: "/membership", label: "会员中心", icon: "◇", requiredPermissions: ["client.membership.view"] },
];

const secondaryNavigation: ConsoleNavigationItem[] = [
  { href: "/workspace", label: "策略实验室", icon: "↗", requiredPermissions: ["client.paper.view"] },
  { href: "/credits", label: "AI 积分", icon: "◎", requiredPermissions: ["client.credits.view"] },
  { href: "/performance-statements", label: "绩效账单", icon: "≋", requiredPermissions: ["client.membership.view"] },
  { href: "/wallet", label: "资产与账本", icon: "◫", requiredPermissions: ["client.wallet.view"] },
  { href: "/wallet/deposits", label: "充值记录", icon: "＋", requiredPermissions: ["client.wallet.view"] },
];

const utilityRouteLabels: Record<string, string> = {
  "/notifications": "通知中心",
  "/account/security": "账户与安全",
  "/legal/consent": "披露与条款",
  "/support": "帮助与支持",
};

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ClientPortalShell({ viewer, access, children }: {
  viewer: ViewerPayload;
  access: EffectiveAccessPayload;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/dashboard";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const primaryItems = useMemo(
    () => visibleNavigation(primaryNavigation, access.permissions),
    [access.permissions],
  );
  const secondaryItems = useMemo(
    () => visibleNavigation(secondaryNavigation, access.permissions),
    [access.permissions],
  );
  const currentItem = [...primaryItems, ...secondaryItems]
    .filter((item) => isActivePath(pathname, item.href))
    .sort((left, right) => right.href.length - left.href.length)[0];
  const currentLabel = currentItem?.label
    ?? Object.entries(utilityRouteLabels).find(([href]) => isActivePath(pathname, href))?.[1]
    ?? "客户页面";
  const displayName = viewer.nickname || viewer.username || viewer.email.split("@")[0];

  useEffect(() => {
    if (!menuOpen) return;
    const drawer = drawerRef.current;
    const returnButton = menuButtonRef.current;
    if (!drawer) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ));
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      returnButton?.focus();
    };
  }, [menuOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login?next=%2Fdashboard");
  }

  const navigation = (items: ConsoleNavigationItem[], className: string) => (
    <nav className={className} aria-label={className === styles.primaryNav ? "客户主导航" : "客户功能导航"}>
      {items.map((item) => <Link
        key={item.href}
        href={item.href}
        className={isActivePath(pathname, item.href) ? styles.active : undefined}
        aria-current={isActivePath(pathname, item.href) ? "page" : undefined}
        onClick={() => setMenuOpen(false)}
      >
        <span aria-hidden="true">{item.icon}</span>{item.label}
      </Link>)}
    </nav>
  );

  return <main className={styles.shell}>
    <a className={styles.skipLink} href="#client-main-content">跳到主要内容</a>
    <header className={styles.header}>
      <Link className={styles.brand} href="/dashboard" aria-label="Riverton Capital 交易总览">
        <Image src="/riverton-capital-logo.png" width={2193} height={324} sizes="(max-width: 640px) 154px, 196px" alt="Riverton Capital" priority />
      </Link>
      {navigation(primaryItems, styles.primaryNav)}
      <div className={styles.headerActions}>
        <Link className={styles.notificationLink} href="/notifications" aria-label="通知中心">通知</Link>
        <details className={styles.accountMenu}>
          <summary><span>{displayName.slice(0, 1).toUpperCase()}</span><b>{displayName}</b></summary>
          <div>
            <Link href="/account/security">账户与安全</Link>
            <Link href="/legal/consent">披露与条款</Link>
            <Link href="/support">帮助与支持</Link>
            <button type="button" onClick={() => void logout()}>退出登录</button>
          </div>
        </details>
        <button
          ref={menuButtonRef}
          className={styles.menuButton}
          type="button"
          aria-label={menuOpen ? "关闭客户导航" : "打开客户导航"}
          aria-expanded={menuOpen}
          aria-controls="client-mobile-nav"
          onClick={() => setMenuOpen((value) => !value)}
        >菜单</button>
      </div>
    </header>

    <div className={styles.productBar}>
      <span>RIVERTON PAPER TRADING</span>
      {navigation(secondaryItems, styles.secondaryNav)}
      <small><i /> 客户测试环境</small>
    </div>

    <button className={`${styles.backdrop} ${menuOpen ? styles.open : ""}`} type="button" tabIndex={-1} aria-label="关闭客户导航" onClick={() => setMenuOpen(false)} />
    <aside ref={drawerRef} id="client-mobile-nav" className={`${styles.drawer} ${menuOpen ? styles.open : ""}`} inert={!menuOpen ? true : undefined} aria-hidden={!menuOpen} role="dialog" aria-modal="true" aria-label="客户导航菜单">
      <header><strong>客户中心</strong><button type="button" onClick={() => setMenuOpen(false)}>关闭</button></header>
      {navigation(primaryItems, styles.drawerNav)}
      {navigation(secondaryItems, styles.drawerNav)}
      <footer>
        <Link href="/notifications">通知中心</Link>
        <Link href="/account/security">账户与安全</Link>
        <Link href="/support">帮助与支持</Link>
        <button type="button" onClick={() => void logout()}>退出登录</button>
      </footer>
    </aside>

    <section className={styles.main}>
      <div className={styles.contextBar}>
        <nav aria-label="面包屑"><Link href="/dashboard">客户中心</Link><span aria-hidden="true">/</span><span aria-current="page">{currentLabel}</span></nav>
        <p><i /> Paper 账户与平台 Demo 证据独立</p>
      </div>
      <div id="client-main-content" className={styles.content} tabIndex={-1}>{children}</div>
    </section>
  </main>;
}
