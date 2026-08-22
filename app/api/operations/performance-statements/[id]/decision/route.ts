import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson,idempotencyKey,requiredString } from "@/lib/commercial-api";
import { executeCommercialApproval } from "@/lib/commercial-approval-adapter";
import { performanceActionDto } from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { assertOperationsStatementScope,operationsCustomerScopeAuthorization } from "@/lib/commercial-operations-scope";
import { ResearchApiError,researchErrorResponse } from "@/lib/research-api";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {user,scope,organizationIds}=await requireAccessPermission(request,"ops.performance_fees.approve");const {id}=await params;const b=await commercialJson(request);const decision=requiredString(b,"decision",10);if(decision!=="approve"&&decision!=="reject")throw new ResearchApiError("VALIDATION_ERROR","decision 无效",422);const pool=await getPostgresPool();const identity={userId:user.id,organizationId:user.organizationId};await assertOperationsStatementScope(pool,scope,identity,id,organizationIds);return Response.json(performanceActionDto(await executeCommercialApproval(pool,{kind:"performance_assessment",subjectId:id,reviewerUserId:user.id,decision,note:requiredString(b,"note",500),idempotencyKey:idempotencyKey(request),authorize:operationsCustomerScopeAuthorization(scope,identity,organizationIds)})));}catch(error){return researchErrorResponse(error,request);}}
