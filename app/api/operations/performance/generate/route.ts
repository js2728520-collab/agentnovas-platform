import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson,requestId,requiredString,stringArray } from "@/lib/commercial-api";
import { generatePerformanceStatement } from "@/lib/performance-fee-service";
import { getPostgresPool } from "@/lib/postgres";
import { assertOperationsCustomerScope } from "@/lib/commercial-operations-scope";
import { researchErrorResponse } from "@/lib/research-api";
export async function POST(request:Request){try{const {user,scope}=await requireAccessPermission(request,"ops.reconciliation.run");const b=await commercialJson(request);const userId=requiredString(b,"userId",100);const pool=await getPostgresPool();await assertOperationsCustomerScope(pool,scope,{userId:user.id,organizationId:user.organizationId},userId);const result=await generatePerformanceStatement(pool,{userId,strategyIds:stringArray(b,"strategyIds",3),weekStart:requiredString(b,"weekStart",40),weekEnd:requiredString(b,"weekEnd",40),generatedByUserId:user.id,requestId:requestId(request)});return Response.json({statement:result},{status:201});}catch(error){return researchErrorResponse(error);}}
