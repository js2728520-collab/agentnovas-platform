import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvalDecisions, approvalRequests, auditLogs, collectionCases, customerAttributions, payoutProfiles, revenueEvents, settlements, users } from "@/db/schema";
import { branchApprovalRoles } from "@/lib/permissions";
import { requireUser, responseError } from "@/lib/session";

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{
 const user=await requireUser(request,[...branchApprovalRoles]);const{id}=await params;const{decision,note=""}=await request.json()as{decision?:"approve"|"reject",note?:string};
 if(!decision)return Response.json({error:"缺少审批决定"},{status:400});const db=getDb();const approval=(await db.select().from(approvalRequests).where(and(eq(approvalRequests.id,id),eq(approvalRequests.status,"pending"))).limit(1))[0];
 if(!approval)return Response.json({error:"审批单不存在或已结束"},{status:404});if(approval.requestedBy===user.id)return Response.json({error:"申请人不能审批自己的申请"},{status:403});if(user.organizationId!==approval.branchId)return Response.json({error:"不能审批其他分公司的申请"},{status:403});
 await db.insert(approvalDecisions).values({id:crypto.randomUUID(),requestId:id,reviewerId:user.id,decision,note});const decisions=await db.select().from(approvalDecisions).where(eq(approvalDecisions.requestId,id));const now=new Date().toISOString();
 if(decision==="reject"){await db.update(approvalRequests).set({status:"rejected",completedAt:now}).where(eq(approvalRequests.id,id));return Response.json({status:"rejected"})}const approvals=decisions.filter(x=>x.decision==="approve");if(approvals.length<2)return Response.json({status:"pending",approvals:approvals.length,required:2});
 if(approval.type==="customer_attribution"||approval.type==="customer_transfer"){const p=JSON.parse(approval.payloadJson)as{branchId:string,managerId:string,supervisorId?:string|null,employeeId?:string|null,effectiveAt:string,reason:string};await db.update(customerAttributions).set({status:"active",source:approval.type==="customer_transfer"?"manual_transfer":undefined,branchId:p.branchId,managerId:p.managerId,supervisorId:p.supervisorId||null,employeeId:p.employeeId||null,effectiveAt:p.effectiveAt,reason:p.reason,approvalId:id,updatedAt:now}).where(eq(customerAttributions.id,approval.subjectId))}
 if(approval.type==="settlement_payment")await db.update(settlements).set({status:"approved",updatedAt:now}).where(eq(settlements.id,approval.subjectId));
 if(approval.type==="revenue_adjustment"){const p=JSON.parse(approval.payloadJson)as{customerId:string,sourceId:string,amountUsdt:number};await db.insert(revenueEvents).values({id:crypto.randomUUID(),customerId:p.customerId,type:"adjustment",sourceId:p.sourceId,amountUsdt:p.amountUsdt,confirmedAt:now,attributionStatus:"manual_adjustment",ruleVersion:"v1",status:"confirmed"})}
 if(approval.type==="payout_profile_change")await db.update(payoutProfiles).set({status:"active",updatedAt:now}).where(eq(payoutProfiles.id,approval.subjectId));
 if(approval.type==="collection_paid_confirmation")await db.update(collectionCases).set({status:"paid",newEntriesAllowed:true,paidConfirmedBy:user.id,paidConfirmedAt:now,updatedAt:now}).where(eq(collectionCases.id,approval.subjectId));
 if(approval.type==="reporting_line_change"){const p=JSON.parse(approval.payloadJson)as{newReportsToUserId:string};await db.update(users).set({reportsToUserId:p.newReportsToUserId,updatedAt:now}).where(eq(users.id,approval.subjectId))}
 await db.batch([db.update(approvalRequests).set({status:"approved",completedAt:now}).where(eq(approvalRequests.id,id)),db.insert(auditLogs).values({id:crypto.randomUUID(),actorUserId:user.id,action:`${approval.type}.approved`,subjectType:approval.subjectType,subjectId:approval.subjectId,afterJson:approval.payloadJson})]);return Response.json({status:"approved",effective:true});
}catch(e){return responseError(e)}}
