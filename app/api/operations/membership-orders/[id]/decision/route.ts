import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson,idempotencyKey,requestId,requiredString } from "@/lib/commercial-api";
import { executeCommercialApproval } from "@/lib/commercial-approval-adapter";
import { membershipActionDto } from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { assertOperationsOrderScope } from "@/lib/commercial-operations-scope";
import { ResearchApiError,researchErrorResponse } from "@/lib/research-api";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {user,scope}=await requireAccessPermission(request,"ops.membership_orders.approve");const {id}=await params;const b=await commercialJson(request);const decision=requiredString(b,"decision",10);if(decision!=="approve"&&decision!=="reject")throw new ResearchApiError("VALIDATION_ERROR","decision 无效",422,{fields:["decision"]});const pool=await getPostgresPool();await assertOperationsOrderScope(pool,scope,{userId:user.id,organizationId:user.organizationId},id);const result=await executeCommercialApproval(pool,{kind:"membership_order",subjectId:id,reviewerUserId:user.id,decision,note:requiredString(b,"note",500),paymentEvidenceId:requiredString(b,"paymentEvidenceId",128),idempotencyKey:idempotencyKey(request),requestId:requestId(request)});return Response.json(membershipActionDto(result));}catch(error){return researchErrorResponse(error);}}
