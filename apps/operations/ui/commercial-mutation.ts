import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";

export async function commercialMutation(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
  locale = "zh-CN",
  sessionExpiredMessage = "会话已过期，正在返回登录页",
) {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    throw new Error(sessionExpiredMessage);
  }
  if (!response.ok) {
    const detail = apiErrorMessage(payload, fallbackMessage);
    throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallbackMessage);
  }
  return payload as Record<string, unknown>;
}
