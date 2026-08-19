import { isSupportedDepositChannel, isSupportedDepositNetwork } from "@/lib/deposits";
import { normalizeDecimalString } from "@/lib/ledger";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { requireAccessPermission } from "@/lib/access-control";

function platformOrderNo() {
  return `DEP${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.wallet.view");
    const pool = await getPostgresPool();
    const result = await pool.query<{
      id: string;
      platform_order_no: string;
      currency: string;
      network: string | null;
      expected_amount: string | null;
      actual_amount: string | null;
      credited_amount: string;
      channel: string;
      deposit_address: string | null;
      tx_id: string | null;
      confirmations: number;
      required_confirmations: number | null;
      order_status: string;
      funds_status: string;
      risk_status: string;
      created_at: Date;
      external_received_at: Date | null;
      credited_at: Date | null;
    }>(`
      SELECT id, platform_order_no, currency, network, expected_amount::text, actual_amount::text,
             credited_amount::text, channel, deposit_address, tx_id, confirmations,
             required_confirmations, order_status, funds_status, risk_status,
             created_at, external_received_at, credited_at
      FROM deposit_orders
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [user.id]);
    return Response.json({
      orders: result.rows.map((row) => ({
        id: row.id,
        platformOrderNo: row.platform_order_no,
        currency: row.currency,
        network: row.network,
        expectedAmount: row.expected_amount,
        actualAmount: row.actual_amount,
        creditedAmount: row.credited_amount,
        channel: row.channel,
        depositAddress: row.deposit_address,
        txId: row.tx_id,
        confirmations: row.confirmations,
        requiredConfirmations: row.required_confirmations,
        orderStatus: row.order_status,
        fundsStatus: row.funds_status,
        riskStatus: row.risk_status,
        createdAt: row.created_at.toISOString(),
        externalReceivedAt: row.external_received_at?.toISOString() ?? null,
        creditedAt: row.credited_at?.toISOString() ?? null,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.deposit.create");
    const body = await readResearchJson(request);
    const channel = String(body.channel ?? "on_chain");
    const network = String(body.network ?? "");
    if (!isSupportedDepositChannel(channel)) throw new ResearchApiError("VALIDATION_ERROR", "充值渠道无效", 422, { fields: ["channel"] });
    if (channel === "on_chain" && !isSupportedDepositNetwork(network)) throw new ResearchApiError("VALIDATION_ERROR", "USDT 网络仅支持 TRC20、ERC20、BEP20", 422, { fields: ["network"] });
    const expectedAmount = normalizeDecimalString(String(body.amount ?? ""));
    const pool = await getPostgresPool();
    const provider = await pool.query<{
      provider: string;
      confirmation_threshold: number | null;
      settings_json: Record<string, unknown>;
    }>(`
      SELECT provider, confirmation_threshold, settings_json
      FROM payment_provider_configs
      WHERE channel = $1
        AND ($2::text IS NULL OR network = $2)
        AND status IN ('sandbox', 'active')
      ORDER BY status = 'active' DESC, updated_at DESC
      LIMIT 1
    `, [channel, channel === "on_chain" ? network : null]);
    if (!provider.rows[0]) throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "充值服务商尚未配置，不能生成虚假充值地址", 503, { channel, network });
    const depositAddress = typeof provider.rows[0].settings_json?.depositAddress === "string"
      ? provider.rows[0].settings_json.depositAddress
      : null;
    if (channel === "on_chain" && !depositAddress) throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "链上充值地址尚未配置", 503, { channel, network });
    const id = crypto.randomUUID();
    const orderNo = platformOrderNo();
    const inserted = await pool.query<{
      id: string;
      platform_order_no: string;
      order_status: string;
      deposit_address: string | null;
      created_at: Date;
    }>(`
      INSERT INTO deposit_orders (
        id, platform_order_no, user_id, branch_id, currency, network,
        expected_amount, usdt_value, channel, provider, deposit_address,
        required_confirmations, order_status, funds_status, risk_status
      )
      SELECT $1, $2, u.id, u.organization_id, 'USDT', $3, $4::numeric, $4::numeric,
             $5, $6, $7, $8, 'PENDING_CONFIRMATION', 'NOT_CREDITED', 'PASS'
      FROM users AS u
      WHERE u.id = $9
      RETURNING id, platform_order_no, order_status, deposit_address, created_at
    `, [
      id,
      orderNo,
      channel === "on_chain" ? network : null,
      expectedAmount,
      channel,
      provider.rows[0].provider,
      depositAddress,
      provider.rows[0].confirmation_threshold,
      user.id,
    ]);
    return Response.json({
      order: {
        id: inserted.rows[0].id,
        platformOrderNo: inserted.rows[0].platform_order_no,
        orderStatus: inserted.rows[0].order_status,
        depositAddress: inserted.rows[0].deposit_address,
        createdAt: inserted.rows[0].created_at.toISOString(),
      },
    }, { status: 201 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

