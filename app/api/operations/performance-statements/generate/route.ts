import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson,idempotencyKey,requestId,requiredString } from "@/lib/commercial-api";
import { generatePerformanceStatement } from "@/lib/performance-fee-service";
import { performanceStatementDto } from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { assertOperationsCustomerScope } from "@/lib/commercial-operations-scope";
import { researchErrorResponse } from "@/lib/research-api";
export async function POST(request:Request){try{const {user,scope}=await requireAccessPermission(request,"ops.performance_fees.generate");const b=await commercialJson(request);const userId=requiredString(b,"userId",100);const pool=await getPostgresPool();await assertOperationsCustomerScope(pool,scope,{userId:user.id,organizationId:user.organizationId},userId);const result=await generatePerformanceStatement(pool,{userId,idempotencyKey:idempotencyKey(request),generatedByUserId:user.id,requestId:requestId(request)});return Response.json({statement:performanceStatementDto(result)},{status:201});}catch(error){return researchErrorResponse(error);}}
