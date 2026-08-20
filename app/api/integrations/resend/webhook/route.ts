import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { getPostgresPool } from "@/lib/postgres";
import { verifyResendWebhook } from "@/lib/resend-webhook";

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function webhookError(error: unknown) {
  const code = error instanceof Error ? error.message : "WEBHOOK_SIGNATURE_INVALID";
  if (code === "WEBHOOK_SIGNATURE_REQUIRED") return new ResearchApiError(code, "缺少 Resend Webhook 签名头", 401);
  if (code === "WEBHOOK_TIMESTAMP_INVALID") return new ResearchApiError(code, "Resend Webhook 时间戳无效", 401);
  if (code === "WEBHOOK_TIMESTAMP_EXPIRED") return new ResearchApiError(code, "Resend Webhook 已过期", 401);
  return new ResearchApiError("WEBHOOK_SIGNATURE_INVALID", "Resend Webhook 签名无效", 401);
}

export async function POST(request: Request) {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
    if (!secret) throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "Resend Webhook 签名密钥尚未配置", 503);

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
      throw new ResearchApiError("REQUEST_TOO_LARGE", "Resend Webhook 请求体过大", 413, { maximumBytes: MAX_WEBHOOK_BODY_BYTES });
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
      throw new ResearchApiError("REQUEST_TOO_LARGE", "Resend Webhook 请求体过大", 413, { maximumBytes: MAX_WEBHOOK_BODY_BYTES });
    }
    let verified: ReturnType<typeof verifyResendWebhook>;
    try {
      verified = verifyResendWebhook({
        body,
        eventId: request.headers.get("svix-id"),
        timestamp: request.headers.get("svix-timestamp"),
        signature: request.headers.get("svix-signature"),
        secret,
      });
    } catch (error) {
      throw webhookError(error);
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new ResearchApiError("INVALID_JSON", "Resend Webhook JSON 无效", 400);
    }

    const eventType = typeof payload.type === "string" ? payload.type : null;
    const pool = await getPostgresPool();
    const result = await pool.query(
      `INSERT INTO resend_webhook_events (event_id, event_type, payload_json)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [verified.eventId, eventType, JSON.stringify(payload)],
    );
    const duplicate = result.rowCount === 0;
    return Response.json({ received: true, duplicate, queued: false }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
