// V3 内部权限注册链接只属于 Operations 五级业务角色。
import { currentRequestAudience } from "@/lib/access-control";
import { hashPassword, normalizeEmail, sha256, validEmail } from "@/lib/auth";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import {
  consumeInternalRegistrationRateLimit,
  recordInternalRegistrationLinkFailure,
  registerWithInternalRegistrationLink,
} from "@/lib/internal-registration-link-service";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { authConnectionBucketKey } from "@/lib/riverton-apps";
import { responseError } from "@/lib/session";

function registrationToken(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed, "https://operations.agentnovas.local");
    const token = url.searchParams.get("staff-invite")
      || new URLSearchParams(url.hash.replace(/^#/, "")).get("staff-invite");
    if (token) return token.trim();
  } catch {
    // 原始 token 不是 URL 时直接使用；不要变更大小写，base64url token 区分大小写。
  }
  return trimmed;
}

export async function POST(request: Request) {
  let tokenHash = "";
  let connection: ReturnType<typeof authConnectionBucketKey> = null;
  try {
    if (currentRequestAudience(request) !== "operations") {
      throw new ResearchApiError("NOT_FOUND", "当前应用不提供内部账号注册", 404);
    }
    const body = await readResearchJson(request, 4_096);
    const token = registrationToken(body.code);
    const email = normalizeEmail(String(body.email ?? ""));
    const password = typeof body.password === "string" ? body.password : "";
    const organizationName = typeof body.organizationName === "string" ? body.organizationName : undefined;
    if (!token) throw new ResearchApiError("STAFF_INVITE_REQUIRED", "缺少权限注册链接标识", 400);
    tokenHash = await sha256(token);
    await ensureDatabaseSchema();
    connection = authConnectionBucketKey(request);
    if (!connection) {
      throw new ResearchApiError("REGISTRATION_NETWORK_UNAVAILABLE", "注册网络身份不可用", 503);
    }
    const pool = await getPostgresPool();
    const rateLimit = await consumeInternalRegistrationRateLimit(pool, {
      email,
      tokenHash,
      connectionBucketKey: connection.bucketKey,
    });
    if (!rateLimit.allowed) {
      await recordInternalRegistrationLinkFailure(pool, {
        tokenHash,
        code: "RATE_LIMITED",
        ipAddress: connection.ipAddress,
        userAgent: request.headers.get("user-agent"),
      });
      return Response.json({
        error: { code: "RATE_LIMITED", message: "注册尝试过于频繁，请稍后重试" },
      }, {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(rateLimit.retryAfterSeconds),
        },
      });
    }
    if (!validEmail(email)) throw new ResearchApiError("EMAIL_INVALID", "请输入有效邮箱", 400);
    if (password.length < 12 || password.length > 128) {
      throw new ResearchApiError("PASSWORD_INVALID", "密码长度必须为 12–128 位", 400);
    }
    const registered = await registerWithInternalRegistrationLink(pool, {
      tokenHash,
      email,
      passwordHash: await hashPassword(password),
      organizationName,
      ipAddress: connection.ipAddress,
      userAgent: request.headers.get("user-agent"),
    });
    return Response.json({
      ok: true,
      status: registered.status,
      role: registered.role,
      organizationId: registered.organizationId,
      mfaEnrollmentRequired: registered.mfaEnrollmentRequired,
      message: "注册成功，账号权限已立即生效。首次登录必须完成 MFA 设置。",
    }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (tokenHash) {
      const pool = await getPostgresPool().catch(() => null);
      if (pool) {
        await recordInternalRegistrationLinkFailure(pool, {
          tokenHash,
          code: error instanceof ResearchApiError ? error.code : "INTERNAL_ERROR",
          ipAddress: connection?.ipAddress ?? null,
          userAgent: request.headers.get("user-agent"),
        }).catch(() => undefined);
      }
    }
    return responseError(error);
  }
}
