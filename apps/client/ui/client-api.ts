export class ClientApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "ClientApiError"; this.status = status; this.code = code;
  }
}

type ErrorLike = { error?: string | { code?: unknown; message?: unknown }; message?: unknown };
function errorFields(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return { code: "UNKNOWN_ERROR", message: fallback };
  const candidate = payload as ErrorLike;
  if (typeof candidate.error === "object" && candidate.error) return {
    code: typeof candidate.error.code === "string" ? candidate.error.code : "UNKNOWN_ERROR",
    message: typeof candidate.error.message === "string" ? candidate.error.message : fallback,
  };
  if (typeof candidate.error === "string") return { code: "UNKNOWN_ERROR", message: candidate.error };
  return { code: "UNKNOWN_ERROR", message: typeof candidate.message === "string" ? candidate.message : fallback };
}

export async function clientRequest<T>(url: string, init: RequestInit = {}, fallback = "请求失败"): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as T | ErrorLike | null;
  if (response.ok) return payload as T;
  if (response.status === 401 && typeof window !== "undefined") {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?next=${encodeURIComponent(next)}`);
  }
  const fields = errorFields(payload, fallback);
  throw new ClientApiError(response.status, fields.code, fields.message);
}

export function newIdempotencyKey() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID() : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function clientErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ClientApiError) {
    if (error.status === 403) return `无权执行此操作：${error.message}`;
    if (error.status === 409) return `当前状态不允许此操作：${error.message}`;
    if (error.status === 422) return `提交内容需要调整：${error.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}
