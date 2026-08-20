import { requireAccessPermission } from "@/lib/access-control";
import { submitMembershipOrder } from "@/lib/commercial-membership-service";
import { getPostgresPool } from "@/lib/postgres";
import { assertOperationsOrderScope } from "@/lib/commercial-operations-scope";
import { researchErrorResponse } from "@/lib/research-api";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const {user,scope}=await requireAccessPermission(request,"ops.reconciliation.run");const {id}=await params;const pool=await getPostgresPool();await assertOperationsOrderScope(pool,scope,{userId:user.id,organizationId:user.organizationId},id);return Response.json(await submitMembershipOrder(pool,id,user.id));}catch(error){return researchErrorResponse(error);}}
