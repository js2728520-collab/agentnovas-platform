import { createHash } from "node:crypto";

import { requestIdFor } from "@/lib/api-policy";
import { resolveUdunRuntimeConfig } from "@/lib/payment-secret-broker";
import { getPaymentWebhookPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import {
  assertFreshUdunTimestamp, parseUdunDepositCallback, parseUdunHttpEnvelope,
  verifyUdunEnvelope,
} from "@/lib/udun-payment";

function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function providerAck(extra: Record<string, unknown> = {}) {
  return Response.json({ code: 200, message: "SUCCESS", ...extra }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await context.params;
    if (provider.toLowerCase() !== "udun") throw new ResearchApiError("NOT_FOUND", "支付服务商不存在", 404);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 65_536) throw new ResearchApiError("PAYLOAD_TOO_LARGE", "回调请求体过大", 413);
    const raw = await request.text();
    if (!raw || Buffer.byteLength(raw, "utf8") > 65_536) throw new ResearchApiError("PAYLOAD_TOO_LARGE", "回调请求体过大", 413);
    let envelope;
    try { envelope = parseUdunHttpEnvelope(request.headers.get("content-type"), raw); }
    catch { throw new ResearchApiError("WEBHOOK_INVALID", "优盾回调格式无效", 400); }
    const runtime = await resolveUdunRuntimeConfig("maintenance");
    if (!verifyUdunEnvelope({ ...envelope, key: runtime.apiKey })) {
      throw new ResearchApiError("WEBHOOK_SIGNATURE_INVALID", "优盾回调验签失败", 401);
    }
    let providerTimestampMs: number;
    try { providerTimestampMs = assertFreshUdunTimestamp(envelope.timestamp); }
    catch { throw new ResearchApiError("WEBHOOK_EXPIRED", "优盾回调时间戳已过期", 409); }
    let callback;
    try { callback = parseUdunDepositCallback(envelope.body); }
    catch { throw new ResearchApiError("WEBHOOK_INVALID", "优盾充值回调字段无效", 422); }

    const client = await (await getPaymentWebhookPostgresPool()).connect();
    const currentRequestId = requestIdFor(request);
    try {
      await client.query("BEGIN");
      const duplicate = await client.query<{ outcome: string }>(`
        SELECT outcome FROM deposit_provider_events
        WHERE provider='udun' AND (provider_event_id=$1 OR nonce_sha256=$2) LIMIT 1 FOR SHARE
      `, [callback.eventId, sha256(envelope.nonce)]);
      if (duplicate.rows[0]) {
        await client.query("COMMIT");
        return providerAck({ replayed: true });
      }
      const orderResult = await client.query<{
        id: string; provider_config_id: string | null; user_id: string; network: string | null;
        order_status: string; tx_id: string | null; settings_json: Record<string, unknown>;
      }>(`
        SELECT d.id,d.provider_config_id,d.user_id,d.network,d.order_status,d.tx_id,p.settings_json
        FROM deposit_orders d JOIN payment_webhook_provider_configs_safe p ON p.id=d.provider_config_id
        WHERE d.provider='udun' AND d.deposit_address=$1
        LIMIT 1 FOR UPDATE OF d
      `, [callback.address]);
      const order = orderResult.rows[0];
      let outcome: "ignored" | "manual_review" | "rejected" = "rejected";
      let errorCode: string | null = null;
      if (!order) {
        errorCode = "UDUN_DEPOSIT_ORDER_NOT_FOUND";
      } else if (String(order.settings_json.mainCoinType ?? "") !== callback.mainCoinType
        || String(order.settings_json.tokenCoinType ?? "") !== callback.coinType) {
        errorCode = "UDUN_COIN_MAPPING_MISMATCH";
      } else {
        const txConflict = await client.query<{ id: string }>(`
          SELECT id FROM deposit_orders WHERE network=$1 AND tx_id=$2 AND id<>$3 LIMIT 1 FOR SHARE
        `, [order.network, callback.txId, order.id]);
        if (txConflict.rows[0]) {
          errorCode = "UDUN_TX_ALREADY_MAPPED";
        } else if (callback.status === 3) {
          const updated = await client.query(`
            UPDATE deposit_orders SET actual_amount=$2::numeric,usdt_value=$2::numeric,tx_id=$3,
              provider_event_id=$4,confirmations=COALESCE(required_confirmations,1),
              order_status='MANUAL_REVIEW',risk_status='REVIEW',
              risk_reasons_json='["UDUN_VERIFIED_CALLBACK_REQUIRES_MAKER_CHECKER"]'::jsonb,
              external_received_at=COALESCE(external_received_at,now()),updated_at=now()
            WHERE id=$1 AND ledger_transaction_id IS NULL AND order_status IN ('PENDING_CONFIRMATION','CONFIRMING','MANUAL_REVIEW')
            RETURNING id
          `, [order.id, callback.amount, callback.txId, callback.eventId]);
          outcome = updated.rows[0] ? "manual_review" : "ignored";
          if (!updated.rows[0]) errorCode = "UDUN_ORDER_ALREADY_FINAL";
        } else if (callback.status === 4 || callback.status === 2) {
          await client.query(`UPDATE deposit_orders SET order_status='FAILED',updated_at=now()
            WHERE id=$1 AND ledger_transaction_id IS NULL AND order_status IN ('PENDING_CONFIRMATION','CONFIRMING')`, [order.id]);
          outcome = "ignored";
          errorCode = `UDUN_PROVIDER_STATUS_${callback.status}`;
        } else {
          if (callback.status === 1) await client.query(`UPDATE deposit_orders SET order_status='CONFIRMING',updated_at=now()
            WHERE id=$1 AND order_status='PENDING_CONFIRMATION'`, [order.id]);
          outcome = "ignored";
        }
      }
      await client.query(`
        INSERT INTO deposit_provider_events(
          id,provider,provider_event_id,provider_config_id,deposit_order_id,event_type,outcome,
          payload_sha256,nonce_sha256,provider_timestamp_ms,tx_id,deposit_address,amount,status_code,error_code,request_id
        ) VALUES($1,'udun',$2,$3,$4,'deposit_callback',$5,$6,$7,$8,$9,$10,$11::numeric,$12,$13,$14)
      `, [
        crypto.randomUUID(), callback.eventId, order?.provider_config_id ?? null, order?.id ?? null, outcome,
        sha256(envelope.body), sha256(envelope.nonce), providerTimestampMs, callback.txId, callback.address,
        callback.amount, callback.status, errorCode, currentRequestId,
      ]);
      await client.query("COMMIT");
      return providerAck({ outcome });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
