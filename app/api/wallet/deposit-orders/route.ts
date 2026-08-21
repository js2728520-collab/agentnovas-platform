import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey, requestId } from "@/lib/commercial-api";
import { isSupportedDepositNetwork } from "@/lib/deposits";
import { compareDecimalStrings, normalizeDecimalString } from "@/lib/ledger";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { readUdunRuntimeConfig, requestUdunDepositAddress } from "@/lib/udun-payment";

function platformOrderNo() {
  return `DEP${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

type DepositRow = {
  id: string; platform_order_no: string; currency: string; network: string | null;
  expected_amount: string | null; actual_amount: string | null; credited_amount: string;
  channel: string; provider: string | null; deposit_address: string | null; tx_id: string | null;
  confirmations: number; required_confirmations: number | null; order_status: string;
  funds_status: string; risk_status: string; created_at: Date; external_received_at: Date | null;
  credited_at: Date | null;
};

function depositDto(row: DepositRow) {
  return {
    id: row.id, platformOrderNo: row.platform_order_no, currency: row.currency, network: row.network,
    expectedAmount: row.expected_amount, actualAmount: row.actual_amount, creditedAmount: row.credited_amount,
    channel: row.channel, provider: row.provider, depositAddress: row.deposit_address, txId: row.tx_id,
    confirmations: row.confirmations, requiredConfirmations: row.required_confirmations,
    orderStatus: row.order_status, fundsStatus: row.funds_status, riskStatus: row.risk_status,
    createdAt: row.created_at.toISOString(), externalReceivedAt: row.external_received_at?.toISOString() ?? null,
    creditedAt: row.credited_at?.toISOString() ?? null,
  };
}

const SELECT_COLUMNS = `id,platform_order_no,currency,network,expected_amount::text,actual_amount::text,
  credited_amount::text,channel,provider,deposit_address,tx_id,confirmations,required_confirmations,
  order_status,funds_status,risk_status,created_at,external_received_at,credited_at`;

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.wallet.view");
    const result = await (await getPostgresPool()).query<DepositRow>(`
      SELECT ${SELECT_COLUMNS} FROM deposit_orders
      WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100
    `, [user.id]);
    return Response.json({ orders: result.rows.map(depositDto) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.deposit.create");
    const key = idempotencyKey(request);
    const body = await readResearchJson(request, 4_096);
    const network = String(body.network ?? "").trim().toUpperCase();
    if (!isSupportedDepositNetwork(network)) throw new ResearchApiError(
      "VALIDATION_ERROR", "USDT 网络仅支持 TRC20、ERC20、BEP20", 422, { fields: ["network"] },
    );
    let expectedAmount: string;
    try { expectedAmount = normalizeDecimalString(String(body.amount ?? "")); }
    catch { throw new ResearchApiError("VALIDATION_ERROR", "充值金额格式无效", 422, { fields: ["amount"] }); }
    if (compareDecimalStrings(expectedAmount, "1") < 0 || compareDecimalStrings(expectedAmount, "1000000") > 0) {
      throw new ResearchApiError("VALIDATION_ERROR", "单笔充值金额必须在 1–1,000,000 USDT 之间", 422, { fields: ["amount"] });
    }
    const pool = await getPostgresPool();
    const replay = await pool.query<DepositRow & { user_id: string }>(`
      SELECT ${SELECT_COLUMNS},user_id FROM deposit_orders
      WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1
    `, [user.id, key]);
    if (replay.rows[0]) {
      if (replay.rows[0].network !== network || replay.rows[0].expected_amount !== expectedAmount) {
        throw new ResearchApiError("IDEMPOTENCY_KEY_COLLISION", "Idempotency-Key 已绑定其他充值请求", 409);
      }
      return Response.json({ order: depositDto(replay.rows[0]), replayed: true }, { headers: { "cache-control": "no-store" } });
    }
    const existingOpenOrder = await pool.query<DepositRow>(`
      SELECT ${SELECT_COLUMNS} FROM deposit_orders
      WHERE user_id=$1 AND network=$2 AND provider='udun'
        AND order_status IN ('PENDING_CONFIRMATION','CONFIRMING','MANUAL_REVIEW')
      ORDER BY created_at DESC LIMIT 1
    `, [user.id, network]);
    if (existingOpenOrder.rows[0]) {
      return Response.json({ order: depositDto(existingOpenOrder.rows[0]), replayed: false, reusedOpenOrder: true }, { headers: { "cache-control": "no-store" } });
    }
    const provider = await pool.query<{
      id: string; provider: string; confirmation_threshold: number; settings_json: Record<string, unknown>;
    }>(`
      SELECT id,provider,confirmation_threshold,settings_json FROM client_payment_provider_configs_safe
      WHERE provider='udun' AND channel='on_chain' AND network=$1 AND status='active' LIMIT 1
    `, [network]);
    const selected = provider.rows[0];
    const mainCoinType = String(selected?.settings_json?.mainCoinType ?? "").trim();
    const tokenCoinType = String(selected?.settings_json?.tokenCoinType ?? "").trim();
    if (!selected || selected.settings_json?.protocol !== "legacy_md5" || !/^\d{1,20}$/.test(mainCoinType) || !tokenCoinType) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "优盾充值网络尚未完成币种映射和启用", 503, { provider: "udun", network });
    }
    const runtime = readUdunRuntimeConfig();
    const orderId = crypto.randomUUID();
    const orderNo = platformOrderNo();
    let address: { address: string; coinType: string };
    try {
      address = await requestUdunDepositAddress({
        config: runtime, mainCoinType, alias: `agentnovas-${orderId}`,
        walletId: typeof selected.settings_json.walletId === "string" ? selected.settings_json.walletId : null,
      });
    } catch (error) {
      if (error instanceof ResearchApiError) throw error;
      throw new ResearchApiError("PAYMENT_PROVIDER_UNAVAILABLE", "优盾暂未返回可用充值地址，请稍后重试", 503, { provider: "udun", network });
    }
    try {
      const inserted = await pool.query<DepositRow>(`
        INSERT INTO deposit_orders(
          id,platform_order_no,user_id,branch_id,currency,network,expected_amount,usdt_value,
          channel,provider,provider_config_id,deposit_address,required_confirmations,
          order_status,funds_status,risk_status,risk_reasons_json,metadata_json,idempotency_key,request_id
        ) VALUES($1,$2,$3,$4,'USDT',$5,$6::numeric,$6::numeric,
          'on_chain','udun',$7,$8,$9,'PENDING_CONFIRMATION','NOT_CREDITED','REVIEW',
          '["UDUN_CALLBACK_PENDING_MANUAL_REVIEW"]'::jsonb,$10::jsonb,$11,$12)
        RETURNING ${SELECT_COLUMNS}
      `, [
        orderId, orderNo, user.id, user.organizationId, network, expectedAmount, selected.id, address.address,
        selected.confirmation_threshold, JSON.stringify({ protocol: "legacy_md5", mainCoinType, tokenCoinType, addressCoinType: address.coinType }),
        key, requestId(request),
      ]);
      if (!inserted.rows[0]) throw new ResearchApiError("NOT_FOUND", "客户账户不存在", 404);
      return Response.json({ order: depositDto(inserted.rows[0]), replayed: false }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      const duplicate = await pool.query<DepositRow>(`
        SELECT ${SELECT_COLUMNS} FROM deposit_orders WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1
      `, [user.id, key]);
      if (duplicate.rows[0]) return Response.json({ order: depositDto(duplicate.rows[0]), replayed: true }, { headers: { "cache-control": "no-store" } });
      const concurrentOpenOrder = await pool.query<DepositRow>(`
        SELECT ${SELECT_COLUMNS} FROM deposit_orders
        WHERE user_id=$1 AND network=$2 AND provider='udun'
          AND order_status IN ('PENDING_CONFIRMATION','CONFIRMING','MANUAL_REVIEW')
        ORDER BY created_at DESC LIMIT 1
      `, [user.id, network]);
      if (concurrentOpenOrder.rows[0]) {
        return Response.json(
          { order: depositDto(concurrentOpenOrder.rows[0]), replayed: false, reusedOpenOrder: true },
          { headers: { "cache-control": "no-store" } },
        );
      }
      throw error;
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
