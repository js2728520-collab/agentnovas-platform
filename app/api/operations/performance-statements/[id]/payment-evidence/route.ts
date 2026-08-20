import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson,idempotencyKey,paymentEvidenceInput } from "@/lib/commercial-api";
import { recordPerformancePaymentEvidence } from "@/lib/performance-fee-service";
import { getPostgresPool } from "@/lib/postgres";
import { assertOperationsStatementScope } from "@/lib/commercial-operations-scope";
import { researchErrorResponse } from "@/lib/research-api";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {user,scope}=await requireAccessPermission(request,"ops.performance_fees.payment_evidence");const {id}=await params;const b=await commercialJson(request);const evidenceInput=paymentEvidenceInput(b,"USDT");const pool=await getPostgresPool();await assertOperationsStatementScope(pool,scope,{userId:user.id,organizationId:user.organizationId},id);const evidence=await recordPerformancePaymentEvidence(pool,{statementId:id,actorUserId:user.id,...evidenceInput,idempotencyKey:idempotencyKey(request)});return Response.json({evidence},{status:201});}catch(error){return researchErrorResponse(error);}}
