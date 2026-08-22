"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";

export function useApiData<T>(url: string | null, fallbackError = "数据读取失败") {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const sequence = ++requestSequence.current;
    if (!url) {
      setData(null);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (sequence !== requestSequence.current) return;
      if (response.status === 401) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      if (!response.ok) throw new Error(apiErrorMessage(payload, fallbackError));
      setData(payload as T);
    } catch (reason) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : fallbackError);
    } finally {
      if (sequence === requestSequence.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [fallbackError, url]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      activeRequest.current?.abort();
    };
  }, [refresh]);
  return { data, loading, error, refresh, setData };
}
