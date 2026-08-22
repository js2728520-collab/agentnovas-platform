import { hashPassword, normalizeEmail, sha256, validEmail } from "@/lib/auth";
import { currentRequestAudience } from "@/lib/access-control";
import {
  consumeClientRegistrationRateLimit,
  registerInvitedClient,
} from "@/lib/client-registration-service";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { normalizePhone } from "@/lib/phone";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { authConnectionBucketKey } from "@/lib/riverton-apps";

function normalizeInvitationCode(input: string) {
  const value = input.trim();
  if (!value) return "";
  try {
    const url = new URL(value, "https://agentnovas.local");
    const fromQuery = url.searchParams.get("invite") || url.searchParams.get("invitationCode");
    if (fromQuery) return fromQuery.trim().toUpperCase();
    if (/^https?:$/i.test(url.protocol)) {
      const lastSegment = url.pathname.split("/").filter(Boolean).at(-1);
      if (lastSegment) return lastSegment.trim().toUpperCase();
    }
  } catch {
    // Fall back to treating the field as a raw code.
  }
  return value.toUpperCase();
}

function registrationError(error: unknown) {
  if (error instanceof ResearchApiError) {
    return Response.json({ error: error.message }, {
      status: error.status,
      headers: { "cache-control": "no-store" },
    });
  }
  console.error("Client registration failed", {
    code: error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN",
  });
  return Response.json({ error: "注册失败，请稍后重试" }, {
    status: 500,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    if (currentRequestAudience(request) !== "client") {
      return Response.json({ error: "当前应用不提供客户注册" }, { status: 404 });
    }
    const body = await readResearchJson(request, 4_096);
    const phone = normalizePhone(String(body.phone ?? ""));
    const email = normalizeEmail(String(body.email ?? ""));
    const password = String(body.password ?? "");
    const invitationCode = normalizeInvitationCode(String(body.invitationCode ?? ""));

    if (!phone) return Response.json({ error: "请输入有效手机号（可包含国际区号）" }, { status: 400 });
    if (email && !validEmail(email)) return Response.json({ error: "邮箱格式不正确" }, { status: 400 });
    if (password.length < 10) return Response.json({ error: "密码至少需要 10 位字符" }, { status: 400 });
    if (!invitationCode) return Response.json({ error: "必须填写邀请码" }, { status: 400 });

    await ensureDatabaseSchema();
    const connection = authConnectionBucketKey(request);
    if (!connection) return Response.json({ error: "注册网络身份不可用" }, { status: 503 });
    const pool = await getPostgresPool();
    const rateLimit = await consumeClientRegistrationRateLimit(pool, {
      phone: phone.value,
      connectionBucketKey: connection.bucketKey,
    });
    if (!rateLimit.allowed) {
      return Response.json({ error: "注册尝试过于频繁，请稍后重试" }, {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(rateLimit.retryAfterSeconds),
        },
      });
    }

    const codeHash = await sha256(invitationCode);
    const accountEmail = email || `phone-${(await sha256(phone.value)).slice(0, 18)}@unverified.agentnovas.local`;
    const registered = await registerInvitedClient(pool, {
      codeHash,
      phone: phone.value,
      phoneMasked: phone.masked,
      email: accountEmail,
      passwordHash: await hashPassword(password),
      ipAddress: connection.ipAddress,
      userAgent: request.headers.get("user-agent"),
    });

    return Response.json({
      ok: true,
      message: "注册成功，无需短信验证码；等待完成商业披露确认后开通3天试用",
      verificationRequired: false,
      trial: {
        status: registered.trialStatus,
        expiresAt: null,
        graceEndsAt: null,
        entitlement: "monthly",
      },
    }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return registrationError(error);
  }
}
