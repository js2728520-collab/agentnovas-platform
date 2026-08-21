import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

import { RESEND_SENDER_ADDRESS } from "./notifications.ts";
import { notificationRecipientHash } from "./notification-email-worker.ts";

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
const MAX_EVENT_ID_LENGTH = 256;
const MAX_SIGNATURE_HEADER_LENGTH = 4_096;
const MAX_PROVIDER_MESSAGE_ID_LENGTH = 256;
const MAX_EVENT_TYPE_LENGTH = 100;

type JsonRecord = Record<string, unknown>;

export type ResendDeliveryEvent = {
  eventType: string;
  eventCreatedAt: string;
  providerMessageId: string;
  deliveryId: string | null;
  nextStatus: "sent" | "delivered" | "failed";
  errorCode: string | null;
  rank: number;
};

const DELIVERY_EVENT_RULES = new Map<string, Pick<ResendDeliveryEvent, "nextStatus" | "errorCode" | "rank">>([
  ["email.sent", { nextStatus: "sent", errorCode: null, rank: 10 }],
  ["email.delivery_delayed", { nextStatus: "sent", errorCode: "RESEND_DELIVERY_DELAYED", rank: 20 }],
  ["email.delivered", { nextStatus: "delivered", errorCode: null, rank: 30 }],
  ["email.opened", { nextStatus: "delivered", errorCode: null, rank: 40 }],
  ["email.clicked", { nextStatus: "delivered", errorCode: null, rank: 40 }],
  ["email.complained", { nextStatus: "failed", errorCode: "RESEND_EMAIL_COMPLAINT", rank: 60 }],
  ["email.bounced", { nextStatus: "failed", errorCode: "RESEND_EMAIL_BOUNCED", rank: 60 }],
  ["email.failed", { nextStatus: "failed", errorCode: "RESEND_EMAIL_FAILED", rank: 60 }],
  ["email.suppressed", { nextStatus: "failed", errorCode: "RESEND_EMAIL_SUPPRESSED", rank: 60 }],
]);

export type VerifiedResendWebhook = {
  eventId: string;
  timestamp: number;
};

function decodeBase64(value: string) {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
  const bytes = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/, "");
  const normalizedOutput = bytes.toString("base64").replace(/=+$/, "");
  return normalizedInput === normalizedOutput ? bytes : null;
}

function webhookSecretBytes(secret: string) {
  if (!secret.startsWith("whsec_")) return Buffer.from(secret, "utf8");
  const bytes = decodeBase64(secret.slice("whsec_".length));
  if (!bytes?.length) throw new Error("WEBHOOK_SECRET_INVALID");
  return bytes;
}

function signatureCandidates(header: string) {
  return header
    .trim()
    .split(/\s+/)
    .map((entry) => entry.split(",", 2))
    .filter(([version, signature]) => version === "v1" && Boolean(signature))
    .map(([, signature]) => signature);
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  return value as JsonRecord;
}

function boundedString(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  return value;
}

function normalizedEventTime(value: unknown) {
  const text = boundedString(value, 64);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  return new Date(timestamp).toISOString();
}

export function parseResendDeliveryEvent(payload: unknown): ResendDeliveryEvent | null {
  const envelope = record(payload);
  if (typeof envelope.type !== "string" || envelope.type.length > MAX_EVENT_TYPE_LENGTH) return null;
  const rule = DELIVERY_EVENT_RULES.get(envelope.type);
  if (!rule) return null;

  const data = record(envelope.data);
  const providerMessageId = boundedString(data.email_id, MAX_PROVIDER_MESSAGE_ID_LENGTH);
  if (boundedString(data.from, 320) !== RESEND_SENDER_ADDRESS) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  let deliveryId: string | null = null;
  if (data.tags !== undefined && data.tags !== null) {
    const tagValue = record(data.tags).notification_delivery_id;
    if (tagValue !== undefined) {
      deliveryId = boundedString(tagValue, 128);
      if (!/^[A-Za-z0-9_-]+$/.test(deliveryId)) throw new Error("INVALID_WEBHOOK_PAYLOAD");
    }
  }
  return {
    eventType: envelope.type,
    eventCreatedAt: normalizedEventTime(envelope.created_at),
    providerMessageId,
    deliveryId,
    ...rule,
  };
}

function eventRank(eventType: string | null) {
  return eventType ? DELIVERY_EVENT_RULES.get(eventType)?.rank ?? 0 : 0;
}

export function shouldApplyResendDeliveryEvent(
  current: { eventType: string | null; eventCreatedAt: string | Date | null },
  incoming: ResendDeliveryEvent,
) {
  if (!current.eventCreatedAt) return true;
  const currentTime = new Date(current.eventCreatedAt).getTime();
  const incomingTime = new Date(incoming.eventCreatedAt).getTime();
  if (!Number.isFinite(currentTime)) return true;
  if (incomingTime !== currentTime) return incomingTime > currentTime;
  return incoming.rank > eventRank(current.eventType);
}

function statusAllowsResendDeliveryEvent(currentStatus: string, incoming: ResendDeliveryEvent) {
  if (currentStatus === "failed") return incoming.nextStatus === "failed";
  if (currentStatus === "delivered") return incoming.nextStatus !== "sent";
  return true;
}

export async function applyResendWebhookEvent(pool: Pick<Pool, "connect">, input: {
  eventId: string;
  payload: JsonRecord;
  receivedAt?: Date;
}) {
  const eventType = typeof input.payload.type === "string" && input.payload.type.length <= MAX_EVENT_TYPE_LENGTH
    ? input.payload.type
    : null;
  const deliveryEvent = parseResendDeliveryEvent(input.payload);
  const receivedAt = (input.receivedAt ?? new Date()).toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO resend_webhook_events
         (event_id, event_type, payload_json, event_created_at, provider_message_id, received_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5, $6::timestamptz)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        input.eventId,
        eventType,
        JSON.stringify(input.payload),
        deliveryEvent?.eventCreatedAt ?? null,
        deliveryEvent?.providerMessageId ?? null,
        receivedAt,
      ],
    );
    if (inserted.rows.length === 0) {
      await client.query("COMMIT");
      return { duplicate: true, mapped: false, applied: false };
    }

    let mappedDeliveryId: string | null = null;
    let applied = false;
    if (deliveryEvent) {
      const delivery = await client.query(
        `SELECT delivery.id, delivery.status, delivery.provider_message_id,
                delivery.provider_event_type, delivery.provider_event_at, users.email AS recipient
           FROM notification_deliveries AS delivery
           JOIN users ON users.id=delivery.user_id
          WHERE channel = 'email'
            AND (($1::text IS NOT NULL AND delivery.id = $1) OR delivery.provider_message_id = $2)
          FOR UPDATE OF delivery`,
        [deliveryEvent.deliveryId, deliveryEvent.providerMessageId],
      );
      if (delivery.rows.length === 1) {
        const current = delivery.rows[0] as {
          id: string;
          status: string;
          provider_message_id: string | null;
          provider_event_type: string | null;
          provider_event_at: string | Date | null;
          recipient: string;
        };
        const identityMatches = (!deliveryEvent.deliveryId || current.id === deliveryEvent.deliveryId)
          && (!current.provider_message_id || current.provider_message_id === deliveryEvent.providerMessageId);
        if (identityMatches && ["queued", "sent", "delivered", "failed"].includes(current.status)) {
          mappedDeliveryId = current.id;
          const suppressionReason = deliveryEvent.eventType === "email.bounced" ? "bounce"
            : deliveryEvent.eventType === "email.complained" ? "complaint"
              : deliveryEvent.eventType === "email.suppressed" ? "provider_suppression" : null;
          if (suppressionReason) {
            await client.query(`
              INSERT INTO notification_email_suppressions(
                recipient_hash,reason,source_event_id,active,created_at,updated_at
              ) VALUES($1,$2,$3,true,$4,$4)
              ON CONFLICT(recipient_hash) DO UPDATE SET
                reason=EXCLUDED.reason,source_event_id=EXCLUDED.source_event_id,
                active=true,updated_at=EXCLUDED.updated_at,resolved_at=NULL,
                resolved_by=NULL,resolution_reason=NULL
            `, [notificationRecipientHash(current.recipient), suppressionReason, input.eventId, receivedAt]);
          }
          if (statusAllowsResendDeliveryEvent(current.status, deliveryEvent) && shouldApplyResendDeliveryEvent({
            eventType: current.provider_event_type,
            eventCreatedAt: current.provider_event_at,
          }, deliveryEvent)) {
            await client.query(
              `UPDATE notification_deliveries
                  SET provider_message_id = COALESCE(provider_message_id, $2),
                      status = $3,
                      last_error = $4,
                      provider_event_type = $5,
                      provider_event_at = $6::timestamptz,
                      sent_at = COALESCE(
                        sent_at,
                        to_char($6::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                      ),
                      updated_at = $7
                WHERE id = $1
                RETURNING id`,
              [
                current.id,
                deliveryEvent.providerMessageId,
                deliveryEvent.nextStatus,
                deliveryEvent.errorCode,
                deliveryEvent.eventType,
                deliveryEvent.eventCreatedAt,
                receivedAt,
              ],
            );
            applied = true;
          }
        }
      }
    }
    await client.query(
      `UPDATE resend_webhook_events
          SET mapped_delivery_id = $2, processed_at = $3::timestamptz
        WHERE event_id = $1`,
      [input.eventId, mappedDeliveryId, receivedAt],
    );
    await client.query("COMMIT");
    return { duplicate: false, mapped: Boolean(mappedDeliveryId), applied };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function verifyResendWebhook(input: {
  body: string;
  eventId: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): VerifiedResendWebhook {
  const eventId = input.eventId?.trim();
  const timestampText = input.timestamp?.trim();
  const signature = input.signature?.trim();
  if (!eventId || !timestampText || !signature) throw new Error("WEBHOOK_SIGNATURE_REQUIRED");
  if (eventId.length > MAX_EVENT_ID_LENGTH || signature.length > MAX_SIGNATURE_HEADER_LENGTH) {
    throw new Error("WEBHOOK_SIGNATURE_INVALID");
  }

  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) throw new Error("WEBHOOK_TIMESTAMP_INVALID");
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) throw new Error("WEBHOOK_TIMESTAMP_EXPIRED");

  const expected = createHmac("sha256", webhookSecretBytes(input.secret))
    .update(`${eventId}.${timestampText}.${input.body}`, "utf8")
    .digest();
  const valid = signatureCandidates(signature).some((candidate) => {
    const supplied = decodeBase64(candidate);
    return supplied?.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!valid) throw new Error("WEBHOOK_SIGNATURE_INVALID");
  return { eventId, timestamp };
}
