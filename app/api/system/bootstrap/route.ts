import { count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, authTokens, notificationDeliveries, organizations, users } from "@/db/schema";
import { hashPassword, normalizeEmail, randomToken, sha256, validEmail } from "@/lib/auth";

export async function POST(request: Request) {
  const env = (globalThis as typeof globalThis & { process?: { env?: Record<string,string|undefined> } }).process?.env ?? {};
  const supplied = request.headers.get("x-bootstrap-key");
  if (!env.BOOTSTRAP_SECRET || !supplied || supplied !== env.BOOTSTRAP_SECRET) return Response.json({ error: "初始化密钥无效" }, { status: 403 });
  const body = await request.json() as { email?: string; password?: string };
  const email = normalizeEmail(body.email ?? ""); if (!validEmail(email)) return Response.json({ error: "邮箱无效" }, { status: 400 });
  const db = getDb(); const existing = (await db.select({ value: count() }).from(users).where(eq(users.role, "hq_admin")))[0]?.value ?? 0;
  if (existing > 0) return Response.json({ error: "总公司管理员已初始化，该接口已锁定" }, { status: 409 });
  const hqId=crypto.randomUUID(), userId=crypto.randomUUID(), verifyToken=randomToken(), now=new Date().toISOString();
  await db.batch([
    db.insert(organizations).values({id:hqId,type:"headquarters",name:"AgentNovas 总公司"}),
    db.insert(users).values({id:userId,email,passwordHash:await hashPassword(body.password??""),role:"hq_admin",organizationId:hqId,status:"pending"}),
    db.insert(authTokens).values({id:crypto.randomUUID(),userId,tokenHash:await sha256(verifyToken),purpose:"verify_email",expiresAt:new Date(Date.now()+48*3600_000).toISOString()}),
    db.insert(notificationDeliveries).values({id:crypto.randomUUID(),userId,channel:"email",category:"login_security",templateKey:"bootstrap_verify_email",payloadJson:JSON.stringify({token:verifyToken}),scheduledAt:now}),
    db.insert(auditLogs).values({id:crypto.randomUUID(),actorUserId:userId,action:"system.bootstrap",subjectType:"organization",subjectId:hqId,afterJson:JSON.stringify({email})}),
  ]);
  return Response.json({ok:true,message:"总公司管理员已创建，请通过验证邮件激活。初始化接口现已锁定。"},{status:201});
}
