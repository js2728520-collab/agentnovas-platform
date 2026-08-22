"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  flattenNavigation,
  visibleNavigationGroups,
  type ConsoleNavigationGroup,
  type EffectiveAccessPayload,
  type ViewerPayload,
} from "@/packages/contracts/src/riverton-ui";

import { Icon, isIconName } from "./icon";
import { ThemeToggle } from "./theme-toggle";

function isActivePath(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function ConsoleShell({
  appName,
  appKind,
  statusText,
  accountLabel,
  navigation,
  viewer,
  access,
  children,
}: {
  appName: string;
  appKind: "operations" | "maintenance" | "client";
  statusText: string;
  accountLabel: string;
  navigation: ConsoleNavigationGroup[];
  viewer: ViewerPayload;
  access: EffectiveAccessPayload;
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(false);
  const pathname = usePathname() || "/";
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const groups = useMemo(
    () => visibleNavigationGroups(navigation, access.permissions),
    [access.permissions, navigation],
  );
  const currentItem = useMemo(
    () => flattenNavigation(groups)
      .filter((item) => isActivePath(pathname, item.href))
      .sort((left, right) => right.href.length - left.href.length)[0],
    [groups, pathname],
  );
  const displayName = viewer.nickname || viewer.username || viewer.email.split("@")[0];

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => {
      setCompactNavigation(media.matches);
      if (!media.matches) setMenuOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!menuOpen || !compactNavigation) return;
    const drawer = drawerRef.current;
    const returnButton = menuButtonRef.current;
    if (!drawer) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key === "Tab") {
        const elements = focusable();
        if (!elements.length) return;
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      returnButton?.focus();
    };
  }, [compactNavigation, menuOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }

  return <main className={`rc-console rc-${appKind}`} data-nav={menuOpen ? "open" : undefined}>
    <a className="rc-skip-link" href="#rc-console-content">跳到主要内容</a>
    <button
      className="rc-console-backdrop"
      type="button"
      tabIndex={-1}
      aria-label="关闭导航菜单"
      onClick={() => setMenuOpen(false)}
    />

    <aside
      ref={drawerRef}
      id="rc-console-nav"
      inert={compactNavigation && !menuOpen ? true : undefined}
      aria-hidden={compactNavigation && !menuOpen ? true : undefined}
      role={compactNavigation && menuOpen ? "dialog" : undefined}
      aria-modal={compactNavigation && menuOpen ? true : undefined}
      aria-label={`${appName}菜单`}
    >
      <Link className="rc-console-brand" href="/" aria-label={`Riverton Capital ${appName}`}>
        {appKind === "client"
          ? <Image src="/riverton-capital-logo.png" width={2193} height={324} sizes="186px" alt="Riverton Capital" />
          : <span aria-hidden="true">RC</span>}
        <b>{appKind === "client" ? null : "Riverton Capital"}<small>{appName}</small></b>
      </Link>

      <nav aria-label={`${appName}导航`}>
        {groups.map((group) => <div className="rc-nav-group" key={group.label}>
          <div className="rc-nav-label">{group.label}</div>
          {group.items.map((item) => {
            const active = isActivePath(pathname, item.href);
            return <Link
              key={item.href}
              className={active ? "active" : undefined}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
            >
              <Icon name={isIconName(item.icon) ? item.icon : "dashboard"} />
              <span>{item.label}{item.description && <small>{item.description}</small>}</span>
              {item.badge && <b>{item.badge}</b>}
            </Link>;
          })}
        </div>)}
      </nav>

      <footer>
        <i aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</i>
        <div><b>{displayName}</b><small>{accountLabel}</small></div>
        <button
          className="rc-icon-btn"
          type="button"
          onClick={() => void logout()}
          title="退出登录"
          aria-label="退出登录"
        ><Icon name="logout" /></button>
      </footer>
    </aside>

    <section className="rc-console-main">
      <header className="rc-console-top">
        <button
          ref={menuButtonRef}
          className="rc-icon-btn rc-menu-btn"
          type="button"
          aria-label={menuOpen ? "关闭导航菜单" : "打开导航菜单"}
          aria-expanded={menuOpen}
          aria-controls="rc-console-nav"
          onClick={() => setMenuOpen((value) => !value)}
        ><Icon name="menu" /></button>

        <nav className="rc-breadcrumb" aria-label="面包屑">
          <Link href="/">{appName}</Link>
          <span aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
          <span aria-current="page">{currentItem?.label ?? "当前页面"}</span>
        </nav>

        <div className="rc-topbar-actions">
          <span className="rc-env-badge"><i aria-hidden="true" />{statusText}</span>
          <ThemeToggle />
        </div>
      </header>

      <div id="rc-console-content" className="rc-console-content" tabIndex={-1}>{children}</div>
    </section>
  </main>;
}
