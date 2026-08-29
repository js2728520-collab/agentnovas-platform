"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { visibleNavigationGroups, type ConsoleNavigationGroup, type EffectiveAccessPayload, type ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { Icon, isIconName } from "@/packages/ui/src/icon";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import { clientPrimaryNavigation, resolveClientSection } from "./client-information-architecture";
import { ClientNotifications } from "./client-notifications";
import styles from "./client-portal-shell.module.css";

/**
 * 客户端导航。刻意不复用内部控制台外壳，也不出现指向 "/" 的链接——
 * "/" 是公开落地页，已登录客户的品牌链接必须落在 /dashboard。
 */
const navigationGroups: ConsoleNavigationGroup[] = [{ label: "主导航", items: clientPrimaryNavigation }];

function isActivePath(pathname: string, href: string) {
  return resolveClientSection(pathname) === resolveClientSection(href);
}

export function ClientPortalShell({ viewer, access, children }: {
  viewer: ViewerPayload;
  access: EffectiveAccessPayload;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/dashboard";
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const { t } = useAppLocale();

  const navigationItems = useMemo(
    () => visibleNavigationGroups(navigationGroups, access.permissions).flatMap((group) => group.items),
    [access.permissions],
  );
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

  useEffect(() => {
    if (!accountMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAccountMenuOpen(false);
        accountButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [accountMenuOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login?next=%2Fdashboard");
  }

  return <div className={styles.shell}>
    <a className={styles.skipLink} href="#client-main-content">{t("跳到主要内容")}</a>
    <button
      className={`${styles.backdrop} ${menuOpen ? styles.open : ""}`}
      type="button"
      tabIndex={-1}
      aria-label={t("关闭客户导航")}
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
      aria-label={t("客户导航菜单")}
    >
      <Link className={styles.brand} href="/dashboard" aria-label={`Riverton Capital ${t("数据看板")}`}>
        <Image src="/riverton-capital-logo.png" width={2193} height={324} sizes="186px" alt="Riverton Capital" priority />
      </Link>

      <nav className={styles.nav} aria-label={t("客户导航")}>
        {navigationItems.map((item) => {
          const active = isActivePath(pathname, item.href);
          return <Link
            key={item.href}
            className={active ? styles.active : undefined}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={() => setMenuOpen(false)}
          >
            <Icon name={isIconName(item.icon) ? item.icon : "dashboard"} />
            {t(item.label)}
            {item.badge && <b>{item.badge}</b>}
          </Link>;
        })}
      </nav>

    </aside>

    <section className={styles.main}>
      <header className={styles.header}>
        <button
          ref={menuButtonRef}
          className={`${styles.iconLink} ${styles.menuButton}`}
          type="button"
          aria-label={menuOpen ? t("关闭客户导航") : t("打开客户导航")}
          aria-expanded={menuOpen}
          aria-controls="client-mobile-nav"
          onClick={() => setMenuOpen((value) => !value)}
        ><Icon name="menu" /></button>

        <div className={styles.headerActions}>
          <span className={styles.envBadge}><i aria-hidden="true" />{t("模拟盘 · 实盘路由已关闭")}</span>
          <ClientNotifications key={pathname === "/notifications" ? "legacy-open" : "topbar"} initialOpen={pathname === "/notifications"} />
          <div className={styles.accountMenu} ref={accountMenuRef}>
            <button ref={accountButtonRef} className={styles.accountTrigger} type="button" aria-label={t("用户菜单")} aria-expanded={accountMenuOpen} aria-controls="client-account-menu" onClick={() => setAccountMenuOpen((value) => !value)}>
              <i className={styles.avatar} aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</i>
              <span>{displayName}</span>
            </button>
            {accountMenuOpen && <div id="client-account-menu" className={styles.accountPopover} role="menu">
              <div><b>{displayName}</b><small>{viewer.email}</small></div>
              <Link href="/account-center" role="menuitem" onClick={() => setAccountMenuOpen(false)}><Icon name="wallet" />{t("账户中心")}</Link>
              <Link href="/settings" role="menuitem" onClick={() => setAccountMenuOpen(false)}><Icon name="settings" />{t("设置")}</Link>
              <Link href="/support" role="menuitem" onClick={() => setAccountMenuOpen(false)}><Icon name="inbox" />{t("帮助与支持")}</Link>
              <button type="button" role="menuitem" onClick={() => void logout()}><Icon name="logout" />{t("退出登录")}</button>
            </div>}
          </div>
        </div>
      </header>

      <main id="client-main-content" className={styles.content} tabIndex={-1}>{children}</main>
    </section>
  </div>;
}
