import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate, maskOperationsEmail } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, access, scope, organizationIds } = await requireAccessPermission(request, "ops.customers.view");
    const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "ca", "ca.customer_id", 1, organizationIds);
    const pool = await getPostgresPool();
    const rows = await pool.query<{
      customer_id: string; email: string; status: string; registered_at: string; branch_id: string | null;
      manager_id: string | null; supervisor_id: string | null; employee_id: string | null;
      display_name: string | null; contact_note: string | null;
    }>(`
      SELECT u.id AS customer_id, u.email, u.status, u.created_at AS registered_at,
             ca.branch_id, ca.manager_id, ca.supervisor_id, ca.employee_id,
             cp.display_name, cp.contact_note
      FROM customer_attributions AS ca
      INNER JOIN users AS u ON u.id = ca.customer_id
      LEFT JOIN customer_profiles AS cp ON cp.customer_id = u.id
      WHERE ca.status = 'active' AND ${scoped.clause}
      ORDER BY u.created_at DESC
      LIMIT 1000
    `, scoped.values);
    return Response.json({
      customers: rows.rows.map((row) => ({
        customerId: row.customer_id,
        email: maskOperationsEmail(row.email),
        status: row.status,
        registeredAt: row.registered_at,
        branchId: row.branch_id,
        managerId: row.manager_id,
        supervisorId: row.supervisor_id,
        employeeId: row.employee_id,
        displayName: row.display_name,
        contactNote: row.contact_note,
      })),
      total: rows.rowCount ?? rows.rows.length,
      canManage: Boolean(access.permissions["ops.customers.manage"]),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.customers.manage");
    const body = await readResearchJson(request);
    const customerId = String(body.customerId ?? "");
    const action = String(body.action ?? "");
    if (!customerId || !["edit", "freeze", "restore", "archive"].includes(action)) {
      throw new ResearchApiError("VALIDATION_ERROR", "客户或操作无效", 422, { fields: ["customerId", "action"] });
    }
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new ResearchApiError("VALIDATION_ERROR", "必须填写客户操作原因", 422, { fields: ["reason"] });
    const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "ca", "ca.customer_id", 2, organizationIds);
    const pool = await getPostgresPool();
    const visible = await pool.query(`SELECT ca.customer_id FROM customer_attributions AS ca WHERE ca.customer_id = $1 AND ${scoped.clause} LIMIT 1`, [customerId, ...scoped.values]);
    if (!visible.rows[0]) throw new ResearchApiError("NOT_FOUND", "客户不存在或不在当前数据范围", 404);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const displayName = String(body.displayName ?? "").trim().slice(0, 120);
      const contactNote = String(body.contactNote ?? "").trim().slice(0, 1000);
      await client.query(`
        INSERT INTO customer_profiles (id, customer_id, display_name, contact_note, archived_at, archived_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (customer_id) DO UPDATE SET
          display_name = CASE WHEN $3 <> '' THEN $3 ELSE customer_profiles.display_name END,
          contact_note = CASE WHEN $4 <> '' THEN $4 ELSE customer_profiles.contact_note END,
          archived_at = CASE WHEN $7 THEN $5 ELSE customer_profiles.archived_at END,
          archived_by = CASE WHEN $7 THEN $6 ELSE customer_profiles.archived_by END,
          updated_at = $5
      `, [crypto.randomUUID(), customerId, displayName, contactNote, new Date().toISOString(), user.id, action === "archive"]);
      if (action !== "edit") {
        const status = action === "freeze" ? "frozen" : action === "restore" ? "active" : "closed";
        await client.query("UPDATE users SET status = $1, updated_at = $2 WHERE id = $3", [status, new Date().toISOString(), customerId]);
      }
      await client.query(`
        INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json)
        VALUES ($1, $2, $3, 'customer', $4, $5)
      `, [crypto.randomUUID(), user.id, `customer.${action}`, customerId, JSON.stringify({ action, displayName, contactNote, reason })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return Response.json({ ok: true, message: action === "archive" ? "客户已归档，历史记录已保留" : "客户资料已更新" });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
