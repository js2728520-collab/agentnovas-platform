import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { sha256 } from "@/lib/auth";
import { requireCommercialLegalConsentGate } from "@/lib/commercial-legal-consent-gate";
import { clientRouteRequiresLegalConsent } from "@/lib/commercial-legal-consent-policy";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError } from "@/lib/research-errors";
import { cookieNameForAudience, resolveAppAudienceStrict, sessionPolicyForAudience } from "@/lib/riverton-apps";
import { evaluateSessionAssurance } from "@/lib/session-assurance";

export type CurrentUser = typeof users.$inferSelect;
export type CurrentSession = typeof sessions.$inferSelect;

function cookieValue(request: Request, name: string) {
  const item = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

export async function currentSession(
  request: Request,
  options: { allowPrimaryInternal?: boolean } = {},
): Promise<{ user: CurrentUser; session: CurrentSession; recentMfa: boolean } | null> {
  const audience = resolveAppAudienceStrict({ host: request.headers.get("host") ?? undefined });
  if (!audience) return null;
  const names = [cookieNameForAudience(audience), ...(audience === "client" ? ["an_session"] : [])];
  const token = names.map((name) => cookieValue(request, name)).find(Boolean);
  if (!token) return null;
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const row = (await db.select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      eq(sessions.tokenHash, await sha256(token)),
      eq(sessions.appAudience, audience),
      gt(sessions.expiresAt, nowIso),
      gt(sessions.idleExpiresAt, nowIso),
      gt(sessions.absoluteExpiresAt, nowIso),
      isNull(sessions.revokedAt),
      eq(users.status, "active"),
    )).limit(1))[0];
  if (!row) return null;
  const assurance = evaluateSessionAssurance({
    audience,
    idleExpiresAt: row.session.idleExpiresAt,
    absoluteExpiresAt: row.session.absoluteExpiresAt,
    mfaLevel: row.session.mfaLevel,
    mfaVerifiedAt: row.session.mfaVerifiedAt,
  }, now, options);
  if (!assurance.usable) return null;

  const lastSeenMs = row.session.lastSeenAt ? Date.parse(row.session.lastSeenAt) : 0;
  if (lastSeenMs < now.getTime() - 5 * 60_000) {
    const idleSeconds = options.allowPrimaryInternal && audience !== "client" && row.session.mfaLevel === "primary"
      ? 10 * 60
      : sessionPolicyForAudience(audience).idleSeconds;
    const idleExpiresAt = new Date(Math.min(
      Date.parse(row.session.absoluteExpiresAt!),
      now.getTime() + idleSeconds * 1000,
    )).toISOString();
    await db.update(sessions).set({ lastSeenAt: nowIso, idleExpiresAt })
      .where(and(eq(sessions.id, row.session.id), isNull(sessions.revokedAt)));
  }
  return { ...row, recentMfa: assurance.recentMfa };
}

export async function currentUser(request: Request): Promise<CurrentUser | null> {
  return (await currentSession(request))?.user ?? null;
}

export async function requireCurrentSession(request: Request) {
  const current = await currentSession(request);
  if (!current) throw new ResearchApiError("AUTH_REQUIRED", "请先登录", 401);
  return current;
}

export async function requireRecentMfaSession(request: Request) {
  const current = await currentSession(request);
  if (!current) throw new ResearchApiError("AUTH_REQUIRED", "请先登录", 401);
  if (current.session.appAudience === "client") throw new ResearchApiError("ROUTE_NOT_AVAILABLE", "当前应用不提供内部双重验证", 404);
  if (!current.recentMfa) throw new ResearchApiError("RECENT_MFA_REQUIRED", "请重新登录并完成双重验证后再执行此操作", 403);
  return current;
}

export async function requirePrimarySession(request: Request) {
  const current = await currentSession(request, { allowPrimaryInternal: true });
  if (!current) throw new Response(JSON.stringify({ error: "登录验证已失效，请重新登录" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  return current;
}

export async function requireUser(request: Request, roles?: CurrentUser["role"][]) {
  const user = await currentUser(request);
  if (!user) throw new Response(JSON.stringify({ error: "请先登录" }), { status: 401, headers: { "content-type": "application/json" } });
  if (roles && !roles.includes(user.role)) throw new Response(JSON.stringify({ error: "无权执行此操作" }), { status: 403, headers: { "content-type": "application/json" } });
  const audience = resolveAppAudienceStrict({ host: request.headers.get("host") ?? undefined });
  if (audience === "client" && user.role === "customer" && clientRouteRequiresLegalConsent(new URL(request.url).pathname)) {
    await requireCommercialLegalConsentGate(await getPostgresPool(), user.id);
  }
  return user;
}

export function responseError(error: unknown, suppliedRequestId?: string) {
  const requestId = suppliedRequestId && /^[A-Za-z0-9._:-]{8,128}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : crypto.randomUUID();
  const domainError = error instanceof ResearchApiError ? error : null;
  const status = domainError?.status
    ?? (error instanceof Response && error.status >= 400 && error.status <= 599 ? error.status : 500);
  const code = domainError?.code
    ?? (status === 401 ? "AUTH_REQUIRED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR");
  const message = domainError?.message
    ?? (status === 401 ? "请先登录" : status === 403 ? "无权执行此操作" : status === 404 ? "请求的资源不存在" : "服务器处理失败");
  return Response.json({ error: { code, message }, requestId }, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": requestId },
  });
}
