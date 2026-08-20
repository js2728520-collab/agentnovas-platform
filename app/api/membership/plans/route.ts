import { requireAccessPermission } from "@/lib/access-control";
import { commercialPlanDto } from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request,"client.membership.view");
    const pool=await getPostgresPool();
    const [plans,legal]=await Promise.all([
      pool.query(`SELECT plan_code,version,price_amount::text,price_currency,duration_days,ai_credit_grant::text,performance_fee_bps,status
        FROM commercial_plan_versions WHERE status='active' AND effective_at<=now() ORDER BY price_amount`),
      pool.query(`SELECT id,document_type,version,content_sha256,effective_at FROM commercial_legal_document_versions
        WHERE status='active' AND effective_at<=now() AND approved_at IS NOT NULL ORDER BY document_type`),
    ]);
    return Response.json({plans:plans.rows.map(commercialPlanDto),requiredLegalDocuments:legal.rows.map(row=>({id:row.id,type:row.document_type,version:row.version,contentSha256:row.content_sha256,effectiveAt:new Date(row.effective_at).toISOString()})),orderCreationAvailable:legal.rows.length===7},{headers:{"cache-control":"no-store"}});
  } catch(error){return researchErrorResponse(error);}
}
