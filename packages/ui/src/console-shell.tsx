"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { visibleNavigation, type ConsoleNavigationItem, type EffectiveAccessPayload, type ViewerPayload } from "@/packages/contracts/src/riverton-ui";

export function ConsoleShell({
  appName,
  appKind,
  navigation,
  viewer,
  access,
  children,
}: {
  appName: string;
  appKind: "operations" | "maintenance" | "client";
  navigation: ConsoleNavigationItem[];
  viewer: ViewerPayload;
  access: EffectiveAccessPayload;
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname() || "/";
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const items = useMemo(() => visibleNavigation(navigation, access.permissions), [access.permissions, navigation]);
  const displayName = viewer.nickname || viewer.username || viewer.email.split("@")[0];

  useEffect(() => {
    if (!menuOpen) return;
    const drawer = drawerRef.current;
    const returnButton = menuButtonRef.current;
    if (!drawer) return;
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
      returnButton?.focus();
    };
  }, [menuOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }

  return <main className={`rc-console rc-${appKind}`}>
    <a className="rc-skip-link" href="#rc-console-content">跳到主要内容</a>
    <header className="rc-mobile-bar">
      <button ref={menuButtonRef} type="button" aria-expanded={menuOpen} aria-controls="rc-console-nav" onClick={() => setMenuOpen((value) => !value)}>菜单</button>
      <strong>{appName}</strong>
    </header>
    <button className={`rc-console-backdrop ${menuOpen ? "is-open" : ""}`} type="button" tabIndex={-1} aria-label="关闭导航菜单" onClick={() => setMenuOpen(false)} />
    <aside ref={drawerRef} id="rc-console-nav" className={menuOpen ? "is-open" : ""} role={menuOpen ? "dialog" : undefined} aria-modal={menuOpen || undefined} aria-label={`${appName}菜单`}>
      <Link className="rc-console-brand" href="/"><span>R</span><b>Riverton Capital<small>{appName}</small></b></Link>
      <nav aria-label={`${appName}导航`}>
        {items.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return <Link key={item.href} className={active ? "active" : ""} href={item.href} onClick={() => setMenuOpen(false)}>
            <i aria-hidden="true">{item.icon}</i><span>{item.label}{item.description && <small>{item.description}</small>}</span>
          </Link>;
        })}
      </nav>
      <footer>
        <div><b>{displayName}</b><small>{viewer.role} · {access.source === "rbac" ? "RBAC" : "兼容角色"}</small></div>
        <button type="button" onClick={() => void logout()}>退出</button>
      </footer>
    </aside>
    <section className="rc-console-main">
      <div className="rc-console-top"><span><i />当前连接安全</span><small>{appKind === "operations" ? "运营数据按权限范围展示" : appKind === "maintenance" ? "配置密钥不会在浏览器回显" : "客户资产与通知中心"}</small></div>
      <div id="rc-console-content" className="rc-console-content" tabIndex={-1}>{children}</div>
    </section>
  </main>;
}
