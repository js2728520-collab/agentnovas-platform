"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { EffectiveAccessPayload, ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import type { AppAudience } from "@/lib/riverton-apps";

type AppSessionState =
  | { status: "loading"; viewer: null; access: null; error: null }
  | { status: "anonymous"; viewer: null; access: null; error: null }
  | { status: "error"; viewer: null; access: null; error: string }
  | { status: "authenticated"; viewer: ViewerPayload; access: EffectiveAccessPayload; error: null };

const initialState: AppSessionState = { status: "loading", viewer: null, access: null, error: null };

/**
 * 已解析的会话按 audience 缓存在模块作用域。
 *
 * 三端都挂在 app/[...segments] 这个 catch-all 路由下，点击菜单导航会让整个客户端
 * 组件树重新挂载，useAppSession 也跟着重跑。没有缓存时，每次点菜单都要串行发两个
 * 请求（/api/auth/me → /api/access/me/effective）并整页显示「正在验证会话…」，
 * 用户看到的就是每次点击都闪一次加载块。
 *
 * 缓存让二次挂载直接拿到已认证状态，后台再静默校验一次，因此撤权仍会在下一次
 * 导航时生效。真正的修法是把会话解析放到服务端（RSC），属于后续阶段。
 */
const sessionCache = new Map<AppAudience, AppSessionState>();
const sessionResolvedAt = new Map<AppAudience, number>();

/**
 * 缓存新鲜期内跳过后台校验。
 *
 * 客户端的会话与权限只决定「显示什么菜单、渲染什么按钮」，服务端在每一次 API
 * 调用上独立鉴权，所以这里的短暂陈旧不构成越权——撤权后客户端最多多显示 30 秒
 * 菜单项，点进去照样被服务端拒绝。
 */
const SESSION_FRESH_MS = 30_000;

export function clearAppSessionCache(audience?: AppAudience) {
  if (audience) {
    sessionCache.delete(audience);
    sessionResolvedAt.delete(audience);
  } else {
    sessionCache.clear();
    sessionResolvedAt.clear();
  }
}

export function useAppSession(expectedAudience: AppAudience) {
  const [state, setState] = useState<AppSessionState>(
    () => sessionCache.get(expectedAudience) ?? initialState,
  );
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    // silent 用于后台校验：已有可用会话时不要退回 loading，否则又会闪一次。
    if (!options.silent) setState(initialState);
    try {
      const viewerResponse = await fetch("/api/auth/me", { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!viewerResponse.ok) {
        clearAppSessionCache(expectedAudience);
        setState({ status: "anonymous", viewer: null, access: null, error: null });
        return;
      }
      const viewerPayload = await viewerResponse.json() as { user?: ViewerPayload | null };
      if (!viewerPayload.user) {
        clearAppSessionCache(expectedAudience);
        setState({ status: "anonymous", viewer: null, access: null, error: null });
        return;
      }
      const accessResponse = await fetch("/api/access/me/effective", { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (accessResponse.status === 401) {
        clearAppSessionCache(expectedAudience);
        setState({ status: "anonymous", viewer: null, access: null, error: null });
        return;
      }
      if (!accessResponse.ok) {
        clearAppSessionCache(expectedAudience);
        setState({ status: "error", viewer: null, access: null, error: accessResponse.status === 403 ? "当前账户无权访问此应用" : "权限信息读取失败" });
        return;
      }
      const access = await accessResponse.json() as EffectiveAccessPayload;
      if (access.appId !== expectedAudience) {
        clearAppSessionCache(expectedAudience);
        setState({ status: "error", viewer: null, access: null, error: "当前会话不属于此应用" });
        return;
      }
      const resolved: AppSessionState = { status: "authenticated", viewer: viewerPayload.user, access, error: null };
      sessionCache.set(expectedAudience, resolved);
      sessionResolvedAt.set(expectedAudience, Date.now());
      setState(resolved);
    } catch {
      if (controller.signal.aborted) return;
      // 后台静默校验失败不要打断已经可用的页面：网络抖动不应把用户踢回加载态。
      if (options.silent && sessionCache.has(expectedAudience)) return;
      clearAppSessionCache(expectedAudience);
      setState({ status: "error", viewer: null, access: null, error: "应用启动失败，请检查网络后重试" });
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, [expectedAudience]);

  useEffect(() => {
    const hasUsableSession = sessionCache.get(expectedAudience)?.status === "authenticated";
    const age = Date.now() - (sessionResolvedAt.get(expectedAudience) ?? 0);
    // 新鲜期内直接用缓存，连后台请求都不发：连续点菜单不该每次都打两个接口。
    if (hasUsableSession && age < SESSION_FRESH_MS) return;
    const timer = window.setTimeout(() => void refresh({ silent: hasUsableSession }), 0);
    return () => {
      window.clearTimeout(timer);
      activeRequest.current?.abort();
    };
  }, [expectedAudience, refresh]);

  return { ...state, refresh: () => refresh() };
}
