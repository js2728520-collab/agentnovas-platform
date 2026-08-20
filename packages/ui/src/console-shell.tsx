"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

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
  const pathname = typeof window === "undefined" ? "/" : window.location.pathname;
  const items = useMemo(() => visibleNavigation(navigation, access.permissions), [access.permissions, navigation]);
  const displayName = viewer.nickname || viewer.username || viewer.email.split("@")[0];

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }

  return <main className={`rc-console rc-${appKind}`}>
    <header className="rc-mobile-bar">
      <button type="button" aria-expanded={menuOpen} aria-controls="rc-console-nav" onClick={() => setMenuOpen((value) => !value)}>菜单</button>
      <strong>{appName}</strong>
    </header>
    <aside id="rc-console-nav" className={menuOpen ? "is-open" : ""}>
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
      <div className="rc-console-content">{children}</div>
    </section>
  </main>;
}
