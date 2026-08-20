export type AppAudience = "client" | "operations" | "maintenance";

export type RivertonAppDefinition = {
  id: AppAudience;
  name: string;
  domain: string;
  localPort: number;
  cookieName: string;
  description: string;
};

export const APP_DEFINITIONS: RivertonAppDefinition[] = [
  {
    id: "client",
    name: "Riverton Capital 客户端",
    domain: "agentnovas.com",
    localPort: 3000,
    cookieName: "rc_client_session",
    description: "注册、Agent、策略研发、回测、模拟盘、会员、充值、通知、客服",
  },
  {
    id: "operations",
    name: "Riverton Capital 运营端",
    domain: "zht.agentnovas.com",
    localPort: 3001,
    cookieName: "rc_ops_session",
    description: "客户、组织、充值、账务、收入、结算、审批、客服",
  },
  {
    id: "maintenance",
    name: "Riverton Capital 运维端",
    domain: "xm.agentnovas.com",
    localPort: 3002,
    cookieName: "rc_maint_session",
    description: "模型、Prompt、支付/邮件配置、数据源、权限安全、系统健康",
  },
];

const appById = new Map(APP_DEFINITIONS.map((app) => [app.id, app]));
const appByDomain = new Map(APP_DEFINITIONS.map((app) => [app.domain, app.id]));

export function isAppAudience(value: string | undefined): value is AppAudience {
  return value === "client" || value === "operations" || value === "maintenance";
}

export function cookieNameForAudience(audience: AppAudience) {
  return appById.get(audience)?.cookieName ?? "rc_client_session";
}

export function sessionPolicyForAudience(audience: AppAudience) {
  return audience === "client"
    ? { absoluteSeconds: 7 * 24 * 60 * 60, idleSeconds: 24 * 60 * 60 }
    : { absoluteSeconds: 12 * 60 * 60, idleSeconds: 60 * 60 };
}

export function sessionDeadlinesForAudience(audience: AppAudience, now = new Date()) {
  const policy = sessionPolicyForAudience(audience);
  return {
    lastSeenAt: now.toISOString(),
    idleExpiresAt: new Date(now.getTime() + policy.idleSeconds * 1000).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + policy.absoluteSeconds * 1000).toISOString(),
  };
}

function normalizeHost(host: string | undefined) {
  return (host ?? "").split(",")[0]?.trim().toLowerCase().replace(/:\d+$/, "") ?? "";
}

export function resolveAppAudienceStrict(input: {
  host?: string;
  environment?: Record<string, string | undefined>;
} = {}): AppAudience | null {
  const configured = input.environment?.RIVERTON_APP_AUDIENCE ?? process.env.RIVERTON_APP_AUDIENCE;
  const host = normalizeHost(input.host);
  if (isAppAudience(configured)) {
    const configuredApp = appById.get(configured)!;
    if (host === configuredApp.domain) return configured;
    if (host === "localhost" || host === "127.0.0.1") {
      const port = (input.host ?? "").match(/:(\d+)$/)?.[1];
      return port === String(configuredApp.localPort) ? configured : null;
    }
    return null;
  }
  if (configured) return null;
  if (appByDomain.has(host)) return appByDomain.get(host)!;
  if (host === "localhost" || host === "127.0.0.1") {
    const port = (input.host ?? "").match(/:(\d+)$/)?.[1];
    const app = APP_DEFINITIONS.find((definition) => String(definition.localPort) === port);
    if (app) return app.id;
  }
  return null;
}

export function resolveAppAudience(input: {
  host?: string;
  environment?: Record<string, string | undefined>;
} = {}): AppAudience {
  return resolveAppAudienceStrict(input) ?? "client";
}

export function cookieNamesForRequest(request: Request) {
  const audience = resolveAppAudience({ host: request.headers.get("host") ?? undefined });
  const names = [cookieNameForAudience(audience)];
  if (audience === "client") names.push("an_session");
  return { audience, names };
}

export function sessionCookieHeaders(input: {
  request: Request;
  token: string;
  maxAgeSeconds: number;
  environment?: Record<string, string | undefined>;
}) {
  const audience = resolveAppAudience({ host: input.request.headers.get("host") ?? undefined });
  const environment = input.environment ?? process.env;
  const secure = environment.NODE_ENV === "production" || new URL(input.request.url).protocol === "https:" ? "; Secure" : "";
  const base = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${input.maxAgeSeconds}${secure}`;
  const headers = [`${cookieNameForAudience(audience)}=${input.token}; ${base}`];
  if (audience === "client") headers.push(`an_session=${input.token}; ${base}`);
  return { audience, headers };
}

export function clearSessionCookieHeaders(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
) {
  const audience = resolveAppAudience({ host: request.headers.get("host") ?? undefined });
  const secure = environment.NODE_ENV === "production" || new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const names = audience === "client" ? [cookieNameForAudience(audience), "an_session"] : [cookieNameForAudience(audience)];
  return names.map((name) => `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

export function clientIpFromRequest(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
) {
  const trustedHops = Number(environment.TRUST_PROXY_HOPS);
  if (!Number.isInteger(trustedHops) || trustedHops < 1 || trustedHops > 8) return null;
  const forwarded = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const value = forwarded.at(Math.max(0, forwarded.length - trustedHops))
    ?? request.headers.get("x-real-ip")?.trim()
    ?? "";
  return value && value.length <= 64 && /^[0-9a-f:.]+$/i.test(value) ? value : null;
}
