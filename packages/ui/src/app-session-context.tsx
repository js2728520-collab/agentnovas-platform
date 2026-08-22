"use client";

import { createContext, useContext } from "react";

import type { EffectiveAccessPayload, ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import type { AppAudience } from "@/lib/riverton-apps";

import { useAppSession } from "./use-app-session";

/**
 * 会话上下文。
 *
 * 会话必须在根 layout 里解析一次，而不是在每个页面里各自解析。原因是路由结构：
 * 三端都挂在 app/[...segments] 这个 catch-all 下，实测（生产构建）Next 对 catch-all
 * 段的不同取值当作不同路由匹配，连该层的 layout 一起重挂——只有根 layout 跨导航
 * 保留。会话放在页面里，就会每次点菜单重跑一遍并把整个界面闪空。
 *
 * 所以：根 layout → AppFrame → 本 Provider（解析一次） → 外壳 + 页面内容。
 * 页面只消费，不再自己解析。
 */

type AppSessionValue = ReturnType<typeof useAppSession>;

const AppSessionContext = createContext<AppSessionValue | null>(null);

export function AppSessionProvider({ audience, children }: {
  audience: AppAudience;
  children: React.ReactNode;
}) {
  const session = useAppSession(audience);
  return <AppSessionContext.Provider value={session}>{children}</AppSessionContext.Provider>;
}

export function useAppSessionContext(): AppSessionValue {
  const value = useContext(AppSessionContext);
  if (!value) throw new Error("useAppSessionContext 必须在 AppSessionProvider 内使用");
  return value;
}

/** 已认证会话的窄类型，供只在外壳内渲染的工作区使用。 */
export type AuthenticatedSession = {
  viewer: ViewerPayload;
  access: EffectiveAccessPayload;
};
