import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, organizations, sessions, users } from "@/db/schema";
import { hashPassword, normalizeEmail, validEmail } from "@/lib/auth";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { runtimeSetting } from "@/lib/runtime-setting";

export async function POST(request: Request) {
  try {
    const supplied = request.headers.get("x-bootstrap-key");
    const hostname = new URL(request.url).hostname;
    const isLocalPreview = hostname === "localhost" || hostname === "127.0.0.1";
    const bootstrapSecret = runtimeSetting("BOOTSTRAP_SECRET");
    if (!bootstrapSecret || !supplied || supplied !== bootstrapSecret) return Response.json({ error: "初始化密钥无效" }, { status: 403 });
    const body = await request.json() as { email?: string; password?: string };
    const email = normalizeEmail(body.email ?? ""); if (!validEmail(email)) return Response.json({ error: "邮箱无效" }, { status: 400 });
    if ((body.password ?? "").length < 10) return Response.json({ error: "管理员密码至少需要 10 位" }, { status: 400 });
    await ensureD1Schema();
    const db = getDb();
    const existingAdmin = (await db.select().from(users).where(eq(users.role, "hq_admin")).limit(1))[0];
    if (existingAdmin) {
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(body.password ?? "");
      await db.batch([
        db.update(users).set({ email, passwordHash, status: "active", emailVerifiedAt: now }).where(eq(users.id, existingAdmin.id)),
        db.update(sessions).set({ revokedAt: now }).where(eq(sessions.userId, existingAdmin.id)),
        db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: existingAdmin.id, action: "system.bootstrap_password_reset", subjectType: "user", subjectId: existingAdmin.id, afterJson: JSON.stringify({ email }) }),
      ]);
      return Response.json({ ok: true, message: `${isLocalPreview ? "本地" : "线上"}超级管理员密码已重置，可返回登录。` });
    }
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
