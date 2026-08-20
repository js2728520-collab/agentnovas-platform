import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { customerAttributions, users } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";
export async function GET(request:Request){try{const {scope}=await requireAccessPermission(request,"ops.customers.view");if(scope!=="PLATFORM")return Response.json({error:"公共池仅对平台范围授权开放"},{status:403});const rows=await getDb().select({attributionId:customerAttributions.id,customerId:users.id,email:users.email,registeredAt:users.createdAt,status:customerAttributions.status}).from(customerAttributions).innerJoin(users,eq(users.id,customerAttributions.customerId)).where(and(eq(customerAttributions.source,"public_pool"),eq(customerAttributions.status,"public_pool_pending"))).orderBy(desc(users.createdAt)).limit(200);return Response.json({customers:rows});}catch(e){return responseError(e)}}
