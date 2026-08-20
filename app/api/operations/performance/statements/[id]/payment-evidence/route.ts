import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson,optionalString,requiredString } from "@/lib/commercial-api";
import { recordPerformancePaymentEvidence } from "@/lib/performance-fee-service";
import { getPostgresPool } from "@/lib/postgres";
import { assertOperationsStatementScope } from "@/lib/commercial-operations-scope";
import { researchErrorResponse } from "@/lib/research-api";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {user,scope}=await requireAccessPermission(request,"ops.reconciliation.run");const {id}=await params;const b=await commercialJson(request);const pool=await getPostgresPool();await assertOperationsStatementScope(pool,scope,{userId:user.id,organizationId:user.organizationId},id);const evidence=await recordPerformancePaymentEvidence(pool,{statementId:id,actorUserId:user.id,evidenceKind:requiredString(b,"evidenceKind",40),providerLabel:optionalString(b,"providerLabel",80),reference:requiredString(b,"reference",256),amount:requiredString(b,"amount",50),currency:requiredString(b,"currency",10),occurredAt:requiredString(b,"occurredAt",40),note:optionalString(b,"note",500)});return Response.json({evidence},{status:201});}catch(error){return researchErrorResponse(error);}}
