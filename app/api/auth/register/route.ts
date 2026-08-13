import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, authTokens, customerAttributions, invitations, memberships, notificationDeliveries, users } from "@/db/schema";
import { hashPassword, normalizeEmail, randomToken, sha256, validEmail } from "@/lib/auth";
import { ensureD1Schema } from "@/lib/d1-migrations";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: string; password?: string; invitationCode?: string };
    const email = normalizeEmail(body.email ?? ""); const password = body.password ?? ""; const invitationCode = body.invitationCode?.trim() ?? "";
    if (!validEmail(email)) return Response.json({ error: "请输入有效邮箱" }, { status: 400 });
    if (!invitationCode) return Response.json({ error: "必须填写邀请码" }, { status: 400 });
    await ensureD1Schema();
    const db = getDb();
    if ((await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]) return Response.json({ error: "该邮箱已注册" }, { status: 409 });
    const codeHash = await sha256(invitationCode.toUpperCase());
    const invite = (await db.select().from(invitations).where(and(eq(invitations.codeHash, codeHash), eq(invitations.status, "active"))).limit(1))[0];
    if (!invite) return Response.json({ error: "邀请码无效或已使用" }, { status: 400 });
    const nowDate = new Date(), now = nowDate.toISOString(); const userId = crypto.randomUUID(); const verificationToken = randomToken();
    const trialExpiresAt = new Date(nowDate.getTime() + 3 * 86400_000).toISOString();
    const trialGraceEndsAt = new Date(nowDate.getTime() + 4 * 86400_000).toISOString();
    const attributionId = crypto.randomUUID(); const publicPool = invite.kind === "public_pool_single_use";
    let managerId: string | null = null, supervisorId: string | null = null;
    if (!publicPool && invite.ownerEmployeeId) {
      const people = await db.select({ id: users.id, role: users.role, reportsToUserId: users.reportsToUserId }).from(users);
      const peopleById = new Map(people.map(person => [person.id, person]));
      let person = peopleById.get(invite.ownerEmployeeId), depth = 0;
      while (person && depth++ < 6) {
        if (person.role === "supervisor") supervisorId = person.id;
        if (person.role === "manager") managerId = person.id;
        person = person.reportsToUserId ? peopleById.get(person.reportsToUserId) : undefined;
      }
    }
    await db.batch([
      db.insert(users).values({ id: userId, email, passwordHash: await hashPassword(password), role: "customer", organizationId: publicPool ? null : invite.organizationId, status: "pending" }),
      db.insert(authTokens).values({ id: crypto.randomUUID(), userId, tokenHash: await sha256(verificationToken), purpose: "verify_email", expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() }),
      db.insert(customerAttributions).values({ id: attributionId, customerId: userId, source: publicPool ? "public_pool" : "employee_invite", status: publicPool ? "public_pool_pending" : "active", branchId: publicPool ? null : invite.organizationId, managerId: publicPool ? null : managerId, supervisorId: publicPool ? null : supervisorId, employeeId: publicPool ? null : invite.ownerEmployeeId, effectiveAt: publicPool ? null : now, reason: publicPool ? "总公司客服一次性邀请码" : "员工邀请码自动归因" }),
      db.insert(memberships).values({ id: crypto.randomUUID(), customerId: userId, planCode: "trial_monthly_equivalent", status: "active", startsAt: now, expiresAt: trialExpiresAt, graceEndsAt: trialGraceEndsAt, maxExchangeAccounts: 1, maxActiveStrategies: 1 }),
      ...(publicPool ? [db.update(invitations).set({ status: "used", usedByUserId: userId, usedAt: now, updatedAt: now }).where(eq(invitations.id, invite.id))] : []),
      db.insert(notificationDeliveries).values({ id: crypto.randomUUID(), userId, channel: "email", category: "login_security", templateKey: "verify_email", payloadJson: JSON.stringify({ token: verificationToken }), scheduledAt: now }),
      db.insert(notificationDeliveries).values({ id: crypto.randomUUID(), userId, channel: "in_app", category: "membership_billing", templateKey: "trial_started", payloadJson: JSON.stringify({ trialExpiresAt, trialGraceEndsAt, entitlement: "monthly" }), scheduledAt: now }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: userId, action: "customer.registered", subjectType: "user", subjectId: userId, afterJson: JSON.stringify({ email, invitationKind: invite.kind }), ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") }),
    ]);
    return Response.json({ ok: true, message: "注册成功，已开通3天月卡同等权益体验；请查收验证邮件", verificationPending: true, trial: { expiresAt: trialExpiresAt, graceEndsAt: trialGraceEndsAt, entitlement: "monthly" } }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "注册失败" }, { status: 500 }); }
}
