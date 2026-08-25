"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  visibleNavigationGroups,
  type ConsoleNavigationGroup,
  type EffectiveAccessPayload,
  type ViewerPayload,
} from "@/packages/contracts/src/riverton-ui";
import { Icon, isIconName } from "@/packages/ui/src/icon";
import { ThemeToggle } from "@/packages/ui/src/theme-toggle";

import styles from "./client-portal-shell.module.css";

/**
 * 客户端导航。刻意不复用内部控制台外壳，也不出现指向 "/" 的链接——
 * "/" 是公开落地页，已登录客户的品牌链接必须落在 /dashboard。
 */
const navigationGroups: ConsoleNavigationGroup[] = [
  { label: "交易", items: [
    { href: "/dashboard", label: "交易总览", icon: "dashboard" },
    { href: "/trading-hall", label: "交易大厅", icon: "hall", requiredPermissions: ["client.paper.view"] },
    { href: "/work-records", label: "工作记录", icon: "book", requiredPermissions: ["client.paper.view"] },
    { href: "/paper", label: "模拟组合", icon: "paper", requiredPermissions: ["client.paper.view"] },
    { href: "/market", label: "行情", icon: "chart" },
    { href: "/marketplace", label: "策略广场", icon: "lab" },
    { href: "/follows", label: "我的跟单", icon: "book" },
    { href: "/assistant", label: "AI 助手", icon: "activity" },
  ] },
  { label: "策略实验室", items: [
    { href: "/studio", label: "策略实验室", icon: "lab", requiredPermissions: ["client.paper.view"] },
    { href: "/backtests", label: "策略回测", icon: "calculator", requiredPermissions: ["client.paper.view"] },
  ] },
  { label: "账户", items: [
    { href: "/membership", label: "会员中心", icon: "crown", requiredPermissions: ["client.membership.view"] },
    { href: "/credits", label: "AI 积分", icon: "coins", requiredPermissions: ["client.credits.view"] },
    { href: "/performance-statements", label: "绩效账单", icon: "receipt", requiredPermissions: ["client.membership.view"] },
    { href: "/wallet", label: "资产与账本", icon: "wallet", requiredPermissions: ["client.wallet.view"] },
    { href: "/wallet/deposits", label: "充值记录", icon: "deposit", requiredPermissions: ["client.wallet.view"] },
  ] },
  { label: "其他", items: [
    { href: "/notifications", label: "通知中心", icon: "bell" },
    { href: "/account/security", label: "账户与安全", icon: "shield" },
    { href: "/legal/consent", label: "披露与条款", icon: "file" },
    { href: "/support", label: "帮助与支持", icon: "inbox" },
  ] },
];

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
  const [compact, setCompact] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const groups = useMemo(
    () => visibleNavigationGroups(navigationGroups, access.permissions),
    [access.permissions],
  );
  const currentLabel = useMemo(() => groups
    .flatMap((group) => group.items)
    .filter((item) => isActivePath(pathname, item.href))
    .sort((left, right) => right.href.length - left.href.length)[0]?.label ?? "客户页面",
  [groups, pathname]);
  const displayName = viewer.nickname || viewer.username || viewer.email.split("@")[0];

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => {
      setCompact(media.matches);
      if (!media.matches) setMenuOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!menuOpen || !compact) return;
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
  }, [compact, menuOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login?next=%2Fdashboard");
  }

  return <div className={styles.shell}>
    <a className={styles.skipLink} href="#client-main-content">跳到主要内容</a>
    <button
      className={`${styles.backdrop} ${menuOpen ? styles.open : ""}`}
      type="button"
      tabIndex={-1}
      aria-label="关闭客户导航"
      onClick={() => setMenuOpen(false)}
    />

    <aside
      ref={drawerRef}
      id="client-mobile-nav"
      className={`${styles.sidebar} ${menuOpen ? styles.open : ""}`}
      inert={compact && !menuOpen ? true : undefined}
      aria-hidden={compact && !menuOpen ? true : undefined}
      role={compact && menuOpen ? "dialog" : undefined}
      aria-modal={compact && menuOpen ? true : undefined}
      aria-label="客户导航菜单"
    >
      <Link className={styles.brand} href="/dashboard" aria-label="Riverton Capital 交易总览">
        <Image src="/riverton-capital-logo.png" width={2193} height={324} sizes="186px" alt="Riverton Capital" priority />
        <small>客户端 · 模拟盘</small>
      </Link>

      <nav className={styles.nav} aria-label="客户导航">
        {groups.map((group) => <div className={styles.navGroup} key={group.label}>
          <div className={styles.navLabel}>{group.label}</div>
          {group.items.map((item) => {
            const active = isActivePath(pathname, item.href);
            return <Link
              key={item.href}
              className={active ? styles.active : undefined}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
            >
              <Icon name={isIconName(item.icon) ? item.icon : "dashboard"} />
              {item.label}
              {item.badge && <b>{item.badge}</b>}
            </Link>;
          })}
        </div>)}
      </nav>

      <div className={styles.account}>
        <i className={styles.avatar} aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</i>
        <div><b>{displayName}</b><small>{viewer.email}</small></div>
        <button
          className={styles.iconLink}
          type="button"
          onClick={() => void logout()}
          title="退出登录"
          aria-label="退出登录"
        ><Icon name="logout" /></button>
      </div>
    </aside>

    <section className={styles.main}>
      <header className={styles.header}>
        <button
          ref={menuButtonRef}
          className={`${styles.iconLink} ${styles.menuButton}`}
          type="button"
          aria-label={menuOpen ? "关闭客户导航" : "打开客户导航"}
          aria-expanded={menuOpen}
          aria-controls="client-mobile-nav"
          onClick={() => setMenuOpen((value) => !value)}
        ><Icon name="menu" /></button>

        <nav className={styles.crumb} aria-label="面包屑">
          <Link href="/dashboard">客户中心</Link>
          <span aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
          <span aria-current="page">{currentLabel}</span>
        </nav>

        <div className={styles.headerActions}>
          <span className={styles.envBadge}><i aria-hidden="true" />模拟盘 · 实盘路由已关闭</span>
          <Link className={styles.iconLink} href="/notifications" title="通知中心" aria-label="通知中心"><Icon name="bell" /></Link>
          <ThemeToggle />
        </div>
      </header>

      <div id="client-main-content" className={styles.content} tabIndex={-1}>{children}</div>
    </section>
  </div>;
}
