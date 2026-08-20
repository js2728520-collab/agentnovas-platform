import { requireAccessPermission } from "@/lib/access-control";
import { maskOperationsValue } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, scope } = await requireAccessPermission(request, "ops.ledger.view");
    const params: unknown[] = [];
    const where = scope === "PLATFORM" ? "TRUE" : user.organizationId && ["ORGANIZATION", "ORGANIZATION_SET"].includes(scope)
      ? `owner_organization_id = $${params.push(user.organizationId)}` : "FALSE";
    const pool = await getPostgresPool();
    const result = await pool.query(`SELECT id, owner_organization_id, network, address, status, approval_id, created_at FROM payout_profiles WHERE ${where} ORDER BY created_at DESC`, params);
    return Response.json({ profiles: result.rows.map((row) => ({ id: row.id, ownerOrganizationId: row.owner_organization_id, network: row.network, address: maskOperationsValue(row.address), status: row.status, approvalId: row.approval_id, createdAt: row.created_at })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { user, scope } = await requireAccessPermission(request, "ops.reconciliation.run");
    const body = await readResearchJson(request);
    const network = String(body.network ?? "");
    const address = String(body.address ?? "").trim();
    const ownerOrganizationId = String(body.ownerOrganizationId ?? user.organizationId ?? "");
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!["TRC20", "ERC20", "BEP20"].includes(network) || address.length < 20 || !ownerOrganizationId || !reason) throw new ResearchApiError("VALIDATION_ERROR", "组织、网络、地址和原因均为必填", 422);
    if (scope !== "PLATFORM" && ownerOrganizationId !== user.organizationId) throw new ResearchApiError("FORBIDDEN", "不能管理其他组织的付款资料", 403);
    const pool = await getPostgresPool();
    const profileId = crypto.randomUUID();
    const approvalId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO payout_profiles (id, owner_organization_id, network, address, status, approval_id) VALUES ($1, $2, $3, $4, 'pending_review', $5)`, [profileId, ownerOrganizationId, network, address, approvalId]);
      await client.query(`INSERT INTO approval_requests (id, type, branch_id, subject_type, subject_id, payload_json, requested_by) VALUES ($1, 'payout_profile_change', $2, 'payout_profile', $3, $4, $5)`, [approvalId, user.organizationId, profileId, JSON.stringify({ network, address: maskOperationsValue(address), reason }), user.id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    return Response.json({ profileId, approvalId, status: "pending_review", paymentExecuted: false }, { status: 201 });
  } catch (error) { return researchErrorResponse(error); }
}
