"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

import type { AppAudience } from "@/lib/riverton-apps";
import type { ConsoleNavigationGroup } from "@/packages/contracts/src/riverton-ui";

/**
 * 内部两端（Operations / Maintenance）的持久外壳。
 *
 * 渲染在根 layout 里。实测（生产构建）Next 对 catch-all 段的不同取值当作不同路由
 * 匹配，会把该层的 layout 一起重挂；只有根 layout 跨导航保留。外壳放在页面里，
 * 每次点菜单侧栏顶栏都会消失约 360ms，页面闪空。
 *
 * 外壳走 next/dynamic 单独成块：根 layout 被所有页面共享，静态 import 会把整套
 * 外壳打进登录页等无外壳路由的包。
 */
const ConsoleChrome = dynamic(() => import("./console-chrome"));

const CHROMELESS_PREFIXES = ["/login", "/setup", "/reset-password", "/verify-email"];

function isChromeless(pathname: string) {
  return CHROMELESS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function ConsoleFrame({ audience, appName, statusText, accountLabel, navigation, children }: {
  audience: Extract<AppAudience, "operations" | "maintenance">;
  appName: string;
  statusText: string;
  accountLabel: string;
  navigation: ConsoleNavigationGroup[];
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/";
  if (isChromeless(pathname)) return <>{children}</>;

  return <ConsoleChrome
    appName={appName}
    appKind={audience}
    statusText={statusText}
    accountLabel={accountLabel}
    navigation={navigation}
  >{children}</ConsoleChrome>;
}
