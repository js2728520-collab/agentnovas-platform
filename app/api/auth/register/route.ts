import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, authTokens, customerAttributions, invitations, memberships, notificationDeliveries, users } from "@/db/schema";
import { hashPassword, normalizeEmail, randomToken, sha256, validEmail } from "@/lib/auth";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { normalizePhone } from "@/lib/phone";
import { getAllPlatformSettings } from "@/lib/platform-settings";

function normalizeInvitationCode(input: string) {
  const value = input.trim();
  if (!value) return "";
  try {
    const url = new URL(value, "https://agentnovas.local");
    const fromQuery = url.searchParams.get("invite") || url.searchParams.get("invitationCode");
    if (fromQuery) return fromQuery.trim().toUpperCase();
    if (/^https?:$/i.test(url.protocol)) {
      const lastSegment = url.pathname.split("/").filter(Boolean).at(-1);
      if (lastSegment) return lastSegment.trim().toUpperCase();
    }
  } catch {
    // Fall back to treating the field as a raw code.
  }
  return value.toUpperCase();
}

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
    const platform = await getAllPlatformSettings();
    if (!platform.features.inviteRegistration) return Response.json({ error: "平台当前暂停邀请码注册" }, { status: 503 });
    const body = await request.json() as { phone?: string; email?: string; password?: string; invitationCode?: string };
    const phone = normalizePhone(body.phone ?? "");
    const email = normalizeEmail(body.email ?? "");
    const password = body.password ?? "";
    const invitationCode = normalizeInvitationCode(body.invitationCode ?? "");

    if (!phone) return Response.json({ error: "请输入有效手机号（可包含国际区号）" }, { status: 400 });
    if (!email || !validEmail(email)) return Response.json({ error: "请输入有效邮箱" }, { status: 400 });
    if (password.length < platform.security.passwordMinLength) return Response.json({ error: `密码至少需要 ${platform.security.passwordMinLength} 位字符` }, { status: 400 });
    if (!invitationCode) return Response.json({ error: "必须填写邀请码" }, { status: 400 });

    const db = getDb();
    if ((await db.select({ id: users.id }).from(users).where(eq(users.phone, phone.value)).limit(1))[0]) {
      return Response.json({ error: "该手机号已注册" }, { status: 409 });
    }
    if ((await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]) {
      return Response.json({ error: "该邮箱已注册" }, { status: 409 });
    }

    const codeHash = await sha256(invitationCode.toUpperCase());
    const invite = (await db.select().from(invitations).where(and(eq(invitations.codeHash, codeHash), eq(invitations.status, "active"))).limit(1))[0];
    if (!invite) return Response.json({ error: "邀请码无效或已使用" }, { status: 400 });

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const userId = crypto.randomUUID();
    const trialExpiresAt = new Date(nowDate.getTime() + 3 * 86400_000).toISOString();
    const trialGraceEndsAt = new Date(nowDate.getTime() + 4 * 86400_000).toISOString();
    const publicPool = invite.kind === "public_pool_single_use";
    const maintenanceInvite = invite.kind === "maintenance_admin_single_use";
    const verificationToken = platform.security.requireEmailVerification ? randomToken() : "";
    let managerId: string | null = null;
    let supervisorId: string | null = null;
    let employeeId: string | null = null;

    if (!publicPool && !maintenanceInvite && invite.ownerEmployeeId) {
      const people = await db.select({ id: users.id, role: users.role, reportsToUserId: users.reportsToUserId }).from(users);
      const peopleById = new Map(people.map((person) => [person.id, person]));
      let person = peopleById.get(invite.ownerEmployeeId);
      let depth = 0;
      while (person && depth++ < 6) {
        if (person.role === "employee" && !employeeId) employeeId = person.id;
        if (person.role === "supervisor" && !supervisorId) supervisorId = person.id;
        if (person.role === "manager" && !managerId) managerId = person.id;
        person = person.reportsToUserId ? peopleById.get(person.reportsToUserId) : undefined;
      }
    }

    await db.batch([
      db.insert(users).values({
        id: userId,
        email,
        phone: phone.value,
        passwordHash: await hashPassword(password),
        role: maintenanceInvite ? "maintenance_admin" : "customer",
        organizationId: publicPool || maintenanceInvite ? null : invite.organizationId,
        status: platform.security.requireEmailVerification ? "pending" : "active",
      }),
      ...(maintenanceInvite ? [] : [db.insert(customerAttributions).values({
        id: crypto.randomUUID(),
        customerId: userId,
        source: publicPool ? "public_pool" : "employee_invite",
        status: publicPool ? "public_pool_pending" : "active",
        branchId: publicPool ? null : invite.organizationId,
        managerId: publicPool ? null : managerId,
        supervisorId: publicPool ? null : supervisorId,
        employeeId: publicPool ? null : employeeId,
        effectiveAt: publicPool ? null : now,
        reason: publicPool ? "总公司客服一次性邀请码" : "邀请码自动归因",
      })]),
      ...(maintenanceInvite ? [] : [db.insert(memberships).values({
        id: crypto.randomUUID(),
        customerId: userId,
        planCode: "trial_monthly_equivalent",
        status: "active",
        startsAt: now,
        expiresAt: trialExpiresAt,
        graceEndsAt: trialGraceEndsAt,
        maxExchangeAccounts: 1,
        maxActiveStrategies: 1,
      })]),
      ...((publicPool || maintenanceInvite) ? [db.update(invitations).set({ status: "used", usedByUserId: userId, usedAt: now, updatedAt: now }).where(eq(invitations.id, invite.id))] : []),
      ...(maintenanceInvite ? [] : [db.insert(notificationDeliveries).values({
        id: crypto.randomUUID(),
        userId,
        channel: "in_app",
        category: "membership_billing",
        templateKey: "trial_started",
        payloadJson: JSON.stringify({ trialExpiresAt, trialGraceEndsAt, entitlement: "monthly" }),
        scheduledAt: now,
      })]),
      ...(verificationToken ? [
        db.insert(authTokens).values({ id: crypto.randomUUID(), userId, tokenHash: await sha256(verificationToken), purpose: "verify_email", expiresAt: new Date(nowDate.getTime() + 24 * 3600_000).toISOString() }),
        db.insert(notificationDeliveries).values({ id: crypto.randomUUID(), userId, channel: "email", category: "login_security", templateKey: "verify_email", payloadJson: JSON.stringify({ token: verificationToken }), scheduledAt: now }),
      ] : []),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: userId,
        action: maintenanceInvite ? "maintenance_admin.registered" : "customer.registered",
        subjectType: "user",
        subjectId: userId,
        afterJson: JSON.stringify({ phone: phone.masked, emailProvided: Boolean(email), invitationKind: invite.kind, smsVerification: false }),
        ipAddress: request.headers.get("cf-connecting-ip"),
        userAgent: request.headers.get("user-agent"),
      }),
    ]);

    return Response.json({
      ok: true,
      message: platform.security.requireEmailVerification ? (maintenanceInvite ? "运维账户注册成功，验证邮件已进入发送队列；验证后可登录" : "注册成功，验证邮件已进入发送队列；验证后可登录") : (maintenanceInvite ? "运维账户注册成功，可以登录运维后台" : "注册成功，无需短信验证码；已开通3天月卡同等权益体验"),
      verificationRequired: platform.security.requireEmailVerification,
      trial: maintenanceInvite ? null : { expiresAt: trialExpiresAt, graceEndsAt: trialGraceEndsAt, entitlement: "monthly" },
    }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "注册失败" }, { status: 500 });
  }
}
