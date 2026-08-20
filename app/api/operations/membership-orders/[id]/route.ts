import { requireAccessPermission } from "@/lib/access-control";
import { commercialCustomerScopePredicate } from "@/lib/commercial-operations-scope";
import { membershipOrderDto } from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError,researchErrorResponse } from "@/lib/research-api";

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const {user,scope}=await requireAccessPermission(request,"ops.membership_orders.view"),{id}=await params;
    const values:unknown[]=[id],scoped=commercialCustomerScopePredicate(scope,{userId:user.id,organizationId:user.organizationId},"scope_order","o.user_id",2);values.push(...scoped.values);
    const pool=await getPostgresPool(),result=await pool.query(`SELECT o.*,p.plan_code,p.version FROM commercial_membership_orders o JOIN commercial_plan_versions p ON p.id=o.plan_version_id WHERE o.id=$1 AND ${scoped.clause}`,values),order=result.rows[0];
    if(!order)throw new ResearchApiError("ORDER_NOT_FOUND","会员订单不存在",404);
    const [evidence,decisions]=await Promise.all([pool.query(`SELECT id,evidence_kind,provider_label,reference_masked,amount::text,currency,occurred_at,recorded_by_user_id,created_at FROM commercial_payment_evidence WHERE membership_order_id=$1 ORDER BY created_at`,[id]),pool.query(`SELECT id,reviewer_user_id,decision,created_at FROM commercial_membership_order_decisions WHERE order_id=$1 ORDER BY created_at`,[id])]);
    return Response.json({order:membershipOrderDto(order),evidence:evidence.rows.map(row=>({id:row.id,kind:row.evidence_kind,providerLabel:row.provider_label,referenceMasked:row.reference_masked,amount:row.amount,currency:row.currency,occurredAt:new Date(row.occurred_at).toISOString(),recordedByUserId:row.recorded_by_user_id,createdAt:new Date(row.created_at).toISOString()})),decisions:decisions.rows.map(row=>({id:row.id,reviewerUserId:row.reviewer_user_id,decision:row.decision,createdAt:new Date(row.created_at).toISOString()}))},{headers:{"cache-control":"no-store"}});
  }catch(error){return researchErrorResponse(error);}
}
