import {  desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, invitations } from "@/db/schema";
import { sha256 } from "@/lib/auth";
import { canCreateInvitation, invitationRoles } from "@/lib/permissions";
import { requireUser, responseError } from "@/lib/session";
export async function GET(request:Request){try{const user=await requireUser(request,[...invitationRoles]);const rows=await getDb().select({id:invitations.id,kind:invitations.kind,status:invitations.status,usedAt:invitations.usedAt,createdAt:invitations.createdAt}).from(invitations).where(eq(invitations.issuerUserId,user.id)).orderBy(desc(invitations.createdAt)).limit(100);return Response.json({invitations:rows});}catch(e){return responseError(e)}}
function invitationCode(length:number){
  const letters="ABCDEFGHJKLMNPQRSTUVWXYZ";
  const alphabet=`${letters}23456789`;
  const bytes=crypto.getRandomValues(new Uint8Array(length));
  return `${letters[bytes[0]%letters.length]}${Array.from(bytes.slice(1),byte=>alphabet[byte%alphabet.length]).join("")}`;
}
export async function POST(request:Request){try{const user=await requireUser(request,[...invitationRoles]);const {kind}=await request.json() as {kind?:"employee_reusable"|"public_pool_single_use"|"maintenance_admin_single_use"};if(!kind||!canCreateInvitation(user.role,kind))return Response.json({error:"无权生成该类邀请码"},{status:403});const raw=invitationCode(kind==="employee_reusable"?6:8);const id=crypto.randomUUID();const db=getDb();await db.batch([db.insert(invitations).values({id,codeHash:await sha256(raw),kind,issuerUserId:user.id,ownerEmployeeId:kind==="employee_reusable"?user.id:null,organizationId:kind==="employee_reusable"?user.organizationId:null}),db.insert(auditLogs).values({id:crypto.randomUUID(),actorUserId:user.id,action:"invitation.created",subjectType:"invitation",subjectId:id,afterJson:JSON.stringify({kind,codeLength:raw.length})})]);return Response.json({invitation:{id,code:raw,kind},warning:"邀请码明文仅本次显示"},{status:201});}catch(e){return responseError(e)}}
