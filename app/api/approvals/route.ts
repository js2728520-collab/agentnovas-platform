import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvalDecisions, approvalRequests } from "@/db/schema";
import { branchApprovalRoles } from "@/lib/permissions";
import { requireUser, responseError } from "@/lib/session";
export async function GET(request:Request){try{const actor=await requireUser(request,[...branchApprovalRoles]);const db=getDb();const requests=await db.select().from(approvalRequests).where(and(eq(approvalRequests.branchId,actor.organizationId!),eq(approvalRequests.status,"pending"))).orderBy(desc(approvalRequests.requestedAt)).limit(200);const decisions=await db.select().from(approvalDecisions);return Response.json({requests:requests.map(r=>({...r,payload:JSON.parse(r.payloadJson),approvals:decisions.filter(d=>d.requestId===r.id&&d.decision==="approve").length,required:2}))});}catch(e){return responseError(e)}}
