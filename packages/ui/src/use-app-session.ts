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

export function useAppSession(expectedAudience: AppAudience) {
  const [state, setState] = useState<AppSessionState>(initialState);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setState(initialState);
    try {
      const viewerResponse = await fetch("/api/auth/me", { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!viewerResponse.ok) {
        setState({ status: "anonymous", viewer: null, access: null, error: null });
        return;
      }
      const viewerPayload = await viewerResponse.json() as { user?: ViewerPayload | null };
      if (!viewerPayload.user) {
        setState({ status: "anonymous", viewer: null, access: null, error: null });
        return;
      }
      const accessResponse = await fetch("/api/access/me/effective", { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (accessResponse.status === 401) {
        setState({ status: "anonymous", viewer: null, access: null, error: null });
        return;
      }
      if (!accessResponse.ok) {
        setState({ status: "error", viewer: null, access: null, error: accessResponse.status === 403 ? "当前账户无权访问此应用" : "权限信息读取失败" });
        return;
      }
      const access = await accessResponse.json() as EffectiveAccessPayload;
      if (access.appId !== expectedAudience) {
        setState({ status: "error", viewer: null, access: null, error: "当前会话不属于此应用" });
        return;
      }
      setState({ status: "authenticated", viewer: viewerPayload.user, access, error: null });
    } catch {
      if (controller.signal.aborted) return;
      setState({ status: "error", viewer: null, access: null, error: "应用启动失败，请检查网络后重试" });
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, [expectedAudience]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      activeRequest.current?.abort();
    };
  }, [refresh]);
  return { ...state, refresh };
}
