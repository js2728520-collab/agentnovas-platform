import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request:Request){
  try{
    const {user}=await requireAccessPermission(request,"client.credits.view"),pool=await getPostgresPool();
    const result=await pool.query(`SELECT COALESCE(a.available_credits,0)::text AS available,COALESCE(a.reserved_credits,0)::text AS reserved,COALESCE(a.version,0)::text AS version,COALESCE(a.updated_at,u.created_at) AS updated_at,COALESCE(sum(e.available_delta) FILTER(WHERE e.entry_type='grant'),0)::text AS lifetime_granted,COALESCE(-sum(e.available_delta+e.reserved_delta) FILTER(WHERE e.entry_type='settle'),0)::text AS lifetime_consumed FROM users u LEFT JOIN ai_credit_accounts a ON a.user_id=u.id LEFT JOIN ai_credit_ledger_entries e ON e.account_id=a.id WHERE u.id=$1 GROUP BY u.created_at,a.id`,[user.id]),row=result.rows[0];
    return Response.json({credits:{available:row?.available??"0",reserved:row?.reserved??"0",lifetimeGranted:row?.lifetime_granted??"0",lifetimeConsumed:row?.lifetime_consumed??"0",version:row?.version??"0",updatedAt:new Date(row?.updated_at??0).toISOString()}},{headers:{"cache-control":"no-store"}});
  }catch(error){return researchErrorResponse(error);}
}
