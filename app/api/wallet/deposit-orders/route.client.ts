import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey, requestId } from "@/lib/commercial-api";
import { isSupportedDepositNetwork } from "@/lib/deposits";
import { compareDecimalStrings, normalizeDecimalString } from "@/packages/ledger/src/ledger";
import { resolveUdunRuntimeConfig } from "@/lib/payment-secret-broker";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { requestUdunDepositAddress } from "@/lib/udun-payment";
import { paymentActivationGate } from "@/packages/payments/src/udun-service-management";

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

const OPEN_UDUN_STATUSES = "'ADDRESS_PROVISIONING','ADDRESS_UNKNOWN','PENDING_CONFIRMATION','CONFIRMING','MANUAL_REVIEW'";

type ProviderRow = {
  id: string; provider: string; network: string; confirmation_threshold: number;
  settings_json: Record<string, unknown>; secret_configuration_version: string | null;
  last_test_at: Date | null; last_test_status: string | null; last_test_configuration_version: string | null;
  last_callback_test_at: Date | null; last_callback_test_status: string | null;
  last_callback_test_configuration_version: string | null; broker_available: boolean;
};

async function activeUdunProviders(pool: Awaited<ReturnType<typeof getPostgresPool>>) {
  const result = await pool.query<ProviderRow>(`
    SELECT id,provider,network,confirmation_threshold,settings_json,secret_configuration_version,
      last_test_at,last_test_status,last_test_configuration_version,
      last_callback_test_at,last_callback_test_status,last_callback_test_configuration_version,broker_available
    FROM client_payment_provider_configs_safe
    WHERE provider='udun' AND channel='on_chain' AND status='active'
    ORDER BY network
  `);
  return result.rows.filter((row) => {
    const coinMappingConfigured = Boolean(String(row.settings_json.mainCoinType ?? "").trim()
      && String(row.settings_json.tokenCoinType ?? "").trim());
    return paymentActivationGate({
      secretConfigured: Boolean(row.secret_configuration_version),
      brokerAvailable: row.broker_available,
      coinMappingConfigured,
      providerAuthorized: process.env.PAYMENT_PROVIDER_OUTBOUND_ENABLED === "true",
      configurationVersion: row.secret_configuration_version,
      providerTest: {
        status: row.last_test_status,
        at: row.last_test_at?.toISOString() ?? null,
        configurationVersion: row.last_test_configuration_version,
      },
      callbackTest: {
        status: row.last_callback_test_status,
        at: row.last_callback_test_at?.toISOString() ?? null,
        configurationVersion: row.last_callback_test_configuration_version,
      },
    }).ready;
  });
}

function depositOptions(providers: ProviderRow[], runtimeAvailable: boolean) {
  const available = process.env.PAYMENT_PROVIDER_OUTBOUND_ENABLED === "true" && runtimeAvailable;
  return {
    currency: "USDT" as const,
    networks: available ? providers.map((provider) => provider.network) : [],
    availability: available && providers.length ? "available" as const
      : providers.length ? "temporarily_unavailable" as const : "unavailable" as const,
  };
}

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.wallet.view");
    const pool = await getPostgresPool();
    const [result, providers] = await Promise.all([pool.query<DepositRow>(`
      SELECT ${SELECT_COLUMNS} FROM deposit_orders
      WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100
    `, [user.id]), activeUdunProviders(pool)]);
    let runtimeAvailable = false;
    try { await resolveUdunRuntimeConfig("client"); runtimeAvailable = true; } catch { runtimeAvailable = false; }
    return Response.json({ orders: result.rows.map(depositDto), options: depositOptions(providers, runtimeAvailable) },
      { headers: { "cache-control": "no-store" } });
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
      if (replay.rows[0].network !== network || !replay.rows[0].expected_amount
        || compareDecimalStrings(replay.rows[0].expected_amount, expectedAmount) !== 0) {
        throw new ResearchApiError("IDEMPOTENCY_KEY_COLLISION", "Idempotency-Key 已绑定其他充值请求", 409);
      }
      return Response.json({ order: depositDto(replay.rows[0]), replayed: true }, { headers: { "cache-control": "no-store" } });
    }
    const existingOpenOrder = await pool.query<DepositRow>(`
      SELECT ${SELECT_COLUMNS} FROM deposit_orders
      WHERE user_id=$1 AND network=$2 AND provider='udun'
        AND order_status IN (${OPEN_UDUN_STATUSES})
      ORDER BY created_at DESC LIMIT 1
    `, [user.id, network]);
    if (existingOpenOrder.rows[0]) {
      return Response.json({ order: depositDto(existingOpenOrder.rows[0]), replayed: false, reusedOpenOrder: true }, { headers: { "cache-control": "no-store" } });
    }
    if (process.env.PAYMENT_PROVIDER_OUTBOUND_ENABLED !== "true") {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "充值地址外发尚未授权", 503, { provider: "udun" });
    }
    const selected = (await activeUdunProviders(pool)).find((candidate) => candidate.network === network);
    const mainCoinType = String(selected?.settings_json?.mainCoinType ?? "").trim();
    const tokenCoinType = String(selected?.settings_json?.tokenCoinType ?? "").trim();
    if (!selected || !selected.secret_configuration_version || selected.settings_json?.protocol !== "legacy_md5"
      || !/^\d{1,20}$/.test(mainCoinType) || !tokenCoinType) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "优盾充值网络尚未完成币种映射和启用", 503, { provider: "udun", network });
    }
    const runtime = await resolveUdunRuntimeConfig("client");
    if (runtime.managedConfigurationVersion !== selected.secret_configuration_version) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付配置版本尚未收敛，请稍后重试", 503, {
        provider: "udun", network,
      });
    }
    const orderId = crypto.randomUUID();
    const orderNo = platformOrderNo();
    let reserved: DepositRow;
    try {
      const reservation = await pool.query<DepositRow>(`
        INSERT INTO deposit_orders(
          id,platform_order_no,user_id,branch_id,currency,network,expected_amount,usdt_value,
          channel,provider,provider_config_id,required_confirmations,order_status,funds_status,
          risk_status,risk_reasons_json,metadata_json,idempotency_key,request_id
        ) VALUES($1,$2,$3,$4,'USDT',$5,$6::numeric,$6::numeric,
          'on_chain','udun',$7,$8,'ADDRESS_PROVISIONING','NOT_CREDITED','REVIEW',
          '["UDUN_ADDRESS_PROVISIONING"]'::jsonb,$9::jsonb,$10,$11)
        RETURNING ${SELECT_COLUMNS}
      `, [
        orderId, orderNo, user.id, user.organizationId, network, expectedAmount, selected.id,
        selected.confirmation_threshold,
        JSON.stringify({ protocol: "legacy_md5", mainCoinType, tokenCoinType,
          secretConfigurationVersion: selected.secret_configuration_version }),
        key, requestId(request),
      ]);
      if (!reservation.rows[0]) throw new ResearchApiError("NOT_FOUND", "客户账户不存在", 404);
      reserved = reservation.rows[0];
    } catch (error) {
      const duplicate = await pool.query<DepositRow>(`
        SELECT ${SELECT_COLUMNS} FROM deposit_orders WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1
      `, [user.id, key]);
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].network !== network || !duplicate.rows[0].expected_amount
          || compareDecimalStrings(duplicate.rows[0].expected_amount, expectedAmount) !== 0) {
          throw new ResearchApiError("IDEMPOTENCY_KEY_COLLISION", "Idempotency-Key 已绑定其他充值请求", 409);
        }
        return Response.json({ order: depositDto(duplicate.rows[0]), replayed: true },
          { headers: { "cache-control": "no-store" } });
      }
      const concurrent = await pool.query<DepositRow>(`
        SELECT ${SELECT_COLUMNS} FROM deposit_orders WHERE user_id=$1 AND network=$2 AND provider='udun'
          AND order_status IN (${OPEN_UDUN_STATUSES}) ORDER BY created_at DESC LIMIT 1
      `, [user.id, network]);
      if (concurrent.rows[0]) return Response.json({ order: depositDto(concurrent.rows[0]), replayed: false, reusedOpenOrder: true },
        { headers: { "cache-control": "no-store" } });
      throw error;
    }
    let address: { address: string; coinType: string };
    try {
      address = await requestUdunDepositAddress({
        config: runtime, mainCoinType, alias: `agentnovas-${orderId}`,
        walletId: typeof selected.settings_json.walletId === "string" ? selected.settings_json.walletId : null,
      });
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : "";
      const deterministic = rawCode.startsWith("UDUN_PROVIDER_ERROR:");
      const nextStatus = deterministic ? "ADDRESS_FAILED" : "ADDRESS_UNKNOWN";
      const safeCode = /^[A-Z0-9_:-]{1,80}$/.test(rawCode) ? rawCode : "UDUN_ADDRESS_REQUEST_UNCERTAIN";
      await pool.query(`UPDATE deposit_orders SET order_status=$2,risk_status='REVIEW',
        risk_reasons_json=$3::jsonb,metadata_json=metadata_json || jsonb_build_object('addressErrorCode',$4::text),updated_at=now()
        WHERE id=$1 AND order_status='ADDRESS_PROVISIONING'`, [
        reserved.id, nextStatus, JSON.stringify([deterministic ? "UDUN_ADDRESS_REQUEST_FAILED" : "UDUN_ADDRESS_REQUEST_RESULT_UNKNOWN"]), safeCode,
      ]);
      throw new ResearchApiError("PAYMENT_PROVIDER_UNAVAILABLE",
        deterministic ? "优盾拒绝了充值地址请求，请联系支持" : "充值地址请求结果暂不确定，系统不会自动重试，请联系支持",
        503, { provider: "udun", network, orderId: reserved.id, orderStatus: nextStatus });
    }
    try {
      const completed = await pool.query<DepositRow>(`
        UPDATE deposit_orders SET deposit_address=$2,order_status='PENDING_CONFIRMATION',
          risk_reasons_json='["UDUN_CALLBACK_PENDING_MANUAL_REVIEW"]'::jsonb,
          metadata_json=metadata_json || jsonb_build_object('addressCoinType',$3::text),updated_at=now()
        WHERE id=$1 AND order_status='ADDRESS_PROVISIONING' RETURNING ${SELECT_COLUMNS}
      `, [reserved.id, address.address, address.coinType]);
      if (!completed.rows[0]) throw new Error("UDUN_ADDRESS_RESERVATION_STATE_CONFLICT");
      return Response.json({ order: depositDto(completed.rows[0]), replayed: false },
        { status: 201, headers: { "cache-control": "no-store" } });
    } catch {
      await pool.query(`UPDATE deposit_orders SET order_status='ADDRESS_UNKNOWN',risk_status='REVIEW',
        risk_reasons_json='["UDUN_ADDRESS_MAPPING_CONFLICT"]'::jsonb,updated_at=now()
        WHERE id=$1 AND order_status='ADDRESS_PROVISIONING'`, [reserved.id]).catch(() => undefined);
      throw new ResearchApiError("PAYMENT_ADDRESS_MAPPING_FAILED",
        "充值地址已由服务商生成但本地映射未完成，请勿重新创建并联系支持", 503,
        { provider: "udun", network, orderId: reserved.id });
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
