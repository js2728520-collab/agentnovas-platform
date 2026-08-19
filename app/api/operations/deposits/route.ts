import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

function maskEmail(value: string | null) {
  if (!value) return null;
  const [name, domain] = value.split("@");
  if (!domain) return "***";
  return `${name.slice(0, 2)}***@${domain}`;
}

function maskPhone(value: string | null) {
  if (!value) return null;
  return value.length <= 4 ? "****" : `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export async function GET(request: Request) {
  try {
    const { user, access, scope } = await requireAccessPermission(request, "ops.deposits.view");
    const canRevealPii = Boolean(access.permissions["ops.deposits.pii_reveal"]);
    const pool = await getPostgresPool();
    const url = new URL(request.url);
    const params: unknown[] = [];
    const where = ["1=1"];
    if (scope !== "PLATFORM") {
      params.push(user.organizationId);
      where.push(`d.branch_id = $${params.length}`);
    }
    for (const [queryName, column] of [
      ["status", "d.order_status"],
      ["fundsStatus", "d.funds_status"],
      ["riskStatus", "d.risk_status"],
      ["currency", "d.currency"],
      ["network", "d.network"],
      ["channel", "d.channel"],
    ] as const) {
      const value = url.searchParams.get(queryName);
      if (value) {
        params.push(value);
        where.push(`${column} = $${params.length}`);
      }
    }
    const q = url.searchParams.get("q")?.trim();
    if (q) {
      params.push(`%${q}%`);
      where.push(`(d.platform_order_no ILIKE $${params.length} OR d.tx_id ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR u.nickname ILIKE $${params.length})`);
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);
    params.push(limit);
    const result = await pool.query<{
      id: string;
      platform_order_no: string;
      user_id: string;
      email: string | null;
      phone: string | null;
      nickname: string;
      currency: string;
      network: string | null;
      expected_amount: string | null;
      actual_amount: string | null;
      usdt_value: string | null;
      fee_amount: string;
      credited_amount: string;
      channel: string;
      source_address: string | null;
      provider_order_id: string | null;
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
      SELECT d.id, d.platform_order_no, d.user_id, u.email, u.phone, u.nickname,
             d.currency, d.network, d.expected_amount::text, d.actual_amount::text,
             d.usdt_value::text, d.fee_amount::text, d.credited_amount::text,
             d.channel, d.source_address, d.provider_order_id, d.tx_id,
             d.confirmations, d.required_confirmations, d.order_status,
             d.funds_status, d.risk_status, d.created_at, d.external_received_at, d.credited_at
      FROM deposit_orders AS d
      INNER JOIN users AS u ON u.id = d.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.created_at DESC
      LIMIT $${params.length}
    `, params);
    return Response.json({
      deposits: result.rows.map((row) => ({
        id: row.id,
        platformOrderNo: row.platform_order_no,
        user: {
          id: row.user_id,
          email: canRevealPii ? row.email : maskEmail(row.email),
          phone: canRevealPii ? row.phone : maskPhone(row.phone),
          nickname: row.nickname,
        },
        currency: row.currency,
        network: row.network,
        expectedAmount: row.expected_amount,
        actualAmount: row.actual_amount,
        usdtValue: row.usdt_value,
        feeAmount: row.fee_amount,
        creditedAmount: row.credited_amount,
        channel: row.channel,
        sourceAddress: canRevealPii ? row.source_address : maskPhone(row.source_address),
        providerOrderId: row.provider_order_id,
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

