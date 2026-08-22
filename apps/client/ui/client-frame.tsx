"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

/**
 * 客户端 Portal 的持久外壳，渲染在根 layout 里。
 *
 * 外壳走 next/dynamic 单独成块：根 layout 被所有页面共享，直接静态 import 会把
 * 整套外壳（含会话、图标、导航）打进公开落地页的包，客户端 JS 预算立刻超标。
 *
 * 无外壳路由比内部两端多两条：
 * - "/" 是公开落地页，不是 Portal；
 * - "/workspace" 是遗留 SPA，自带外壳（P4 收编前保持原样）。
 */
const ClientChrome = dynamic(() => import("./client-chrome"));

const CHROMELESS_EXACT = new Set(["/", "/workspace"]);
const CHROMELESS_PREFIXES = ["/login", "/setup", "/reset-password", "/verify-email", "/workspace"];

function isChromeless(pathname: string) {
  if (CHROMELESS_EXACT.has(pathname)) return true;
  return CHROMELESS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export default function ClientFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  if (isChromeless(pathname)) return <>{children}</>;
  return <ClientChrome>{children}</ClientChrome>;
}
