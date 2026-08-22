import { requireAccessPermission } from "@/lib/access-control";
import { operationsCustomerScopeAuthorization } from "@/lib/commercial-operations-scope";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.customers.manage");
    const { id } = await params;
    const body = await readResearchJson(request, 4_096);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (content.length < 1 || content.length > 2_000) throw new ResearchApiError("CUSTOMER_NOTE_INVALID", "备注需要 1–2,000 个字符", 422);
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await operationsCustomerScopeAuthorization(scope, { userId: user.id, organizationId: user.organizationId }, organizationIds)(client, id);
      const noteId = crypto.randomUUID();
      await client.query("INSERT INTO customer_handover_notes(id,customer_id,author_user_id,content,created_at) VALUES($1,$2,$3,$4,now())", [noteId, id, user.id, content]);
      await client.query("INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,created_at) VALUES($1,$2,'customer.handover_note_added','customer',$3,$4::jsonb,now())", [crypto.randomUUID(), user.id, id, JSON.stringify({ noteId })]);
      await client.query("COMMIT");
      return Response.json({ ok: true, noteId, message: "客户备注已保存并记录审计" }, { status: 201 });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
