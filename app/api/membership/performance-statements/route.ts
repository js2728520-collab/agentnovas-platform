import { requireAccessPermission } from "@/lib/access-control";
import { commercialListInput } from "@/lib/commercial-api";
import { encodeCommercialCursor } from "@/lib/commercial-api-support";
import { performanceStatementDto } from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
export async function GET(request:Request){try{const {user}=await requireAccessPermission(request,"client.membership.view");const {limit,cursor}=commercialListInput(request);const params:unknown[]=[user.id];let c="";if(cursor){params.push(cursor.createdAt,cursor.id);c=`AND (created_at,id)<($2::timestamptz,$3)`;}params.push(limit+1);const result=await (await getPostgresPool()).query(`SELECT id,user_id,week_start,week_end,week_net_pnl::text,eligible_profit::text,loss_carry::text,fee_bps,fee_amount::text,currency,status,created_at FROM performance_fee_statements WHERE user_id=$1 ${c} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,params);const rows=result.rows.slice(0,limit),last=rows.at(-1);return Response.json({statements:rows.map(performanceStatementDto),nextCursor:result.rows.length>limit&&last?encodeCommercialCursor({createdAt:new Date(last.created_at).toISOString(),id:last.id}):null},{headers:{"cache-control":"no-store"}});}catch(error){return researchErrorResponse(error);}}
