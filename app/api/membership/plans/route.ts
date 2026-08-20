import { requireAccessPermission } from "@/lib/access-control";
import { hasReadableCommercialLegalContent } from "@/lib/commercial-legal";
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
      pool.query(`SELECT id,document_type,version,content_sha256,content_locale,content_markdown,effective_at FROM commercial_legal_document_versions
        WHERE status='active' AND effective_at<=now() AND approved_at IS NOT NULL ORDER BY document_type`),
    ]);
    const legalDocuments = legal.rows.map((row) => {
      const readable = hasReadableCommercialLegalContent(row);
      return {
        id: row.id,
        type: row.document_type,
        version: row.version,
        contentSha256: row.content_sha256,
        locale: readable ? row.content_locale : null,
        contentMarkdown: readable ? row.content_markdown : null,
        effectiveAt: new Date(row.effective_at).toISOString(),
      };
    });
    return Response.json({
      plans: plans.rows.map(commercialPlanDto),
      requiredLegalDocuments: legalDocuments,
      orderCreationAvailable: legalDocuments.length === 7
        && legalDocuments.every((document) => document.contentMarkdown !== null),
    }, { headers: { "cache-control": "no-store" } });
  } catch(error){return researchErrorResponse(error, request);}
}
