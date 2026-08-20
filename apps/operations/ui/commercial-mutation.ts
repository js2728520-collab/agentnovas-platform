import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";

export async function commercialMutation(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    throw new Error("会话已过期，正在返回登录页");
  }
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, fallbackMessage));
  }
  return payload as Record<string, unknown>;
}
