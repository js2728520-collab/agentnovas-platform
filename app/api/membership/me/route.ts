import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

const statuses={trial:"TRIAL",active:"ACTIVE",grace:"GRACE",read_only:"READ_ONLY",expired:"EXPIRED",cancelled:"CANCELLED"} as const;
export async function GET(request:Request){
  try{
    const {user}=await requireAccessPermission(request,"client.membership.view"),pool=await getPostgresPool();
    const result=await pool.query(`SELECT m.id,m.status,m.starts_at,m.expires_at,cpv.plan_code FROM memberships m JOIN commercial_plan_versions cpv ON cpv.id=m.plan_code WHERE m.customer_id=$1 ORDER BY m.created_at DESC LIMIT 1`,[user.id]),row=result.rows[0];
    if(!row)return Response.json({membership:null},{headers:{"cache-control":"no-store"}});
    const status=statuses[row.status as keyof typeof statuses];if(!status)throw new Error("UNKNOWN_MEMBERSHIP_STATUS");
    return Response.json({membership:{id:row.id,planCode:row.plan_code,status,startsAt:new Date(row.starts_at).toISOString(),expiresAt:row.expires_at?new Date(row.expires_at).toISOString():null,closeOnly:["READ_ONLY","EXPIRED","CANCELLED"].includes(status)}},{headers:{"cache-control":"no-store"}});
  }catch(error){return researchErrorResponse(error, request);}
}
