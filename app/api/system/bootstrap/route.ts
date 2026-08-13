import { count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, organizations, users } from "@/db/schema";
import { hashPassword, normalizeEmail, validEmail } from "@/lib/auth";
import { ensureD1Schema } from "@/lib/d1-migrations";

export async function POST(request: Request) {
  try {
    const env = (globalThis as typeof globalThis & { process?: { env?: Record<string,string|undefined> } }).process?.env ?? {};
    const supplied = request.headers.get("x-bootstrap-key");
    if (!env.BOOTSTRAP_SECRET || !supplied || supplied !== env.BOOTSTRAP_SECRET) return Response.json({ error: "初始化密钥无效" }, { status: 403 });
    const body = await request.json() as { email?: string; password?: string };
    const email = normalizeEmail(body.email ?? ""); if (!validEmail(email)) return Response.json({ error: "邮箱无效" }, { status: 400 });
    if ((body.password ?? "").length < 10) return Response.json({ error: "管理员密码至少需要 10 位" }, { status: 400 });
    await ensureD1Schema();
    const db = getDb(); const existing = (await db.select({ value: count() }).from(users).where(eq(users.role, "hq_admin")))[0]?.value ?? 0;
    if (existing > 0) return Response.json({ error: "总公司管理员已初始化，该接口已锁定" }, { status: 409 });
    const hqId=crypto.randomUUID(), userId=crypto.randomUUID(), now=new Date().toISOString();
    await db.batch([
      db.insert(organizations).values({id:hqId,type:"headquarters",name:"AgentNovas 总公司"}),
      db.insert(users).values({id:userId,email,passwordHash:await hashPassword(body.password??""),role:"hq_admin",organizationId:hqId,status:"active",emailVerifiedAt:now}),
      db.insert(auditLogs).values({id:crypto.randomUUID(),actorUserId:userId,action:"system.bootstrap",subjectType:"organization",subjectId:hqId,afterJson:JSON.stringify({email})}),
    ]);
    return Response.json({ok:true,message:"总公司超级管理员已创建并启用。初始化接口现已锁定，可直接返回首页登录。"},{status:201});
  } catch (error) {
    return Response.json({ error: error instanceof Error ? `初始化失败：${error.message}` : "初始化失败，请稍后重试" }, { status: 500 });
  }
}
