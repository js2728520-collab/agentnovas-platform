import { requireAccessPermission } from "@/lib/access-control";
import { membershipAccess } from "@/lib/membership-rules";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request:Request){
  try{
    const {user}=await requireAccessPermission(request,"client.membership.view"),pool=await getPostgresPool();
    const result=await pool.query(`
      SELECT m.id,m.status,m.starts_at,m.expires_at,m.grace_ends_at,m.created_at,
             COALESCE(cpv.plan_code,m.plan_code) AS plan_code
        FROM memberships m
        LEFT JOIN commercial_plan_versions cpv ON cpv.id=m.plan_code
       WHERE m.customer_id=$1
       ORDER BY m.created_at DESC
       LIMIT 1
    `,[user.id]),row=result.rows[0];
    if(!row)return Response.json({membership:null},{headers:{"cache-control":"no-store"}});
    const access=membershipAccess(new Date().toISOString(),{status:row.status,expiresAt:row.expires_at,graceEndsAt:row.grace_ends_at});
    const status=row.status==="expired"?"EXPIRED":row.status==="cancelled"?"CANCELLED":access.status==="read_only"?"READ_ONLY":access.status==="grace"?"GRACE":row.plan_code==="trial_monthly_equivalent"?"TRIAL":"ACTIVE";
    return Response.json({membership:{id:row.id,planCode:row.plan_code,status,startsAt:new Date(row.starts_at??row.created_at).toISOString(),expiresAt:row.expires_at?new Date(row.expires_at).toISOString():null,closeOnly:access.closeOnly}},{headers:{"cache-control":"no-store"}});
  }catch(error){return researchErrorResponse(error, request);}
}
