import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { membershipActionDto } from "@/lib/commercial-public-contract";
import { submitMembershipOrder } from "@/lib/commercial-membership-service";
import { getPostgresPool } from "@/lib/postgres";
import { assertOperationsOrderScope,operationsCustomerScopeAuthorization } from "@/lib/commercial-operations-scope";
import { researchErrorResponse } from "@/lib/research-api";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {user,scope,organizationIds}=await requireAccessPermission(request,"ops.membership_orders.evidence");const {id}=await params;const pool=await getPostgresPool();const identity={userId:user.id,organizationId:user.organizationId};await assertOperationsOrderScope(pool,scope,identity,id,organizationIds);return Response.json(membershipActionDto(await submitMembershipOrder(pool,{orderId:id,actorUserId:user.id,idempotencyKey:idempotencyKey(request),authorize:operationsCustomerScopeAuthorization(scope,identity,organizationIds)})));}catch(error){return researchErrorResponse(error,request);}}
