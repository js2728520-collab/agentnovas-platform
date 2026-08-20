import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, customerAttributions, invitations, memberships, notificationDeliveries, users } from "@/db/schema";
import { hashPassword, normalizeEmail, sha256, validEmail } from "@/lib/auth";
import { currentRequestAudience } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { normalizePhone } from "@/lib/phone";
import { clientIpFromRequest } from "@/lib/riverton-apps";

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
    if (currentRequestAudience(request) !== "client") {
      return Response.json({ error: "当前应用不提供客户注册" }, { status: 404 });
    }
    const body = await request.json() as { phone?: string; email?: string; password?: string; invitationCode?: string };
    const phone = normalizePhone(body.phone ?? "");
    const email = normalizeEmail(body.email ?? "");
    const password = body.password ?? "";
    const invitationCode = normalizeInvitationCode(body.invitationCode ?? "");

    if (!phone) return Response.json({ error: "请输入有效手机号（可包含国际区号）" }, { status: 400 });
    if (email && !validEmail(email)) return Response.json({ error: "邮箱格式不正确" }, { status: 400 });
    if (password.length < 10) return Response.json({ error: "密码至少需要 10 位字符" }, { status: 400 });
    if (!invitationCode) return Response.json({ error: "必须填写邀请码" }, { status: 400 });

    await ensureDatabaseSchema();
    const db = getDb();
    if ((await db.select({ id: users.id }).from(users).where(eq(users.phone, phone.value)).limit(1))[0]) {
      return Response.json({ error: "该手机号已注册" }, { status: 409 });
    }
    if (email && (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]) {
      return Response.json({ error: "该邮箱已注册" }, { status: 409 });
    }

    const codeHash = await sha256(invitationCode.toUpperCase());
    const invite = (await db.select().from(invitations).where(and(eq(invitations.codeHash, codeHash), eq(invitations.status, "active"))).limit(1))[0];
    if (!invite) return Response.json({ error: "邀请码无效或已使用" }, { status: 400 });

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const userId = crypto.randomUUID();
    const accountEmail = email || `phone-${(await sha256(phone.value)).slice(0, 18)}@unverified.agentnovas.local`;
    const trialExpiresAt = new Date(nowDate.getTime() + 3 * 86400_000).toISOString();
    const trialGraceEndsAt = new Date(nowDate.getTime() + 4 * 86400_000).toISOString();
    const publicPool = invite.kind === "public_pool_single_use";
    let managerId: string | null = null;
    let supervisorId: string | null = null;

    if (!publicPool && invite.ownerEmployeeId) {
      const people = await db.select({ id: users.id, role: users.role, reportsToUserId: users.reportsToUserId }).from(users);
      const peopleById = new Map(people.map((person) => [person.id, person]));
      let person = peopleById.get(invite.ownerEmployeeId);
      let depth = 0;
      while (person && depth++ < 6) {
        if (person.role === "supervisor") supervisorId = person.id;
        if (person.role === "manager") managerId = person.id;
        person = person.reportsToUserId ? peopleById.get(person.reportsToUserId) : undefined;
      }
    }

    await db.batch([
      db.insert(users).values({
        id: userId,
        email: accountEmail,
        phone: phone.value,
        passwordHash: await hashPassword(password),
        role: "customer",
        organizationId: publicPool ? null : invite.organizationId,
        status: "active",
      }),
      db.insert(customerAttributions).values({
        id: crypto.randomUUID(),
        customerId: userId,
        source: publicPool ? "public_pool" : "employee_invite",
        status: publicPool ? "public_pool_pending" : "active",
        branchId: publicPool ? null : invite.organizationId,
        managerId: publicPool ? null : managerId,
        supervisorId: publicPool ? null : supervisorId,
        employeeId: publicPool ? null : invite.ownerEmployeeId,
        effectiveAt: publicPool ? null : now,
        reason: publicPool ? "总公司客服一次性邀请码" : "邀请码自动归因",
      }),
      db.insert(memberships).values({
        id: crypto.randomUUID(),
        customerId: userId,
        planCode: "trial_monthly_equivalent",
        status: "active",
        startsAt: now,
        expiresAt: trialExpiresAt,
        graceEndsAt: trialGraceEndsAt,
        maxExchangeAccounts: 1,
        maxActiveStrategies: 1,
      }),
      ...(publicPool ? [db.update(invitations).set({ status: "used", usedByUserId: userId, usedAt: now, updatedAt: now }).where(eq(invitations.id, invite.id))] : []),
      db.insert(notificationDeliveries).values({
        id: crypto.randomUUID(),
        userId,
        channel: "in_app",
        category: "membership_billing",
        templateKey: "trial_started",
        payloadJson: JSON.stringify({ trialExpiresAt, trialGraceEndsAt, entitlement: "monthly" }),
        scheduledAt: now,
      }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: userId,
        action: "customer.registered",
        subjectType: "user",
        subjectId: userId,
        afterJson: JSON.stringify({ phone: phone.masked, emailProvided: Boolean(email), invitationKind: invite.kind, smsVerification: false }),
        ipAddress: clientIpFromRequest(request),
        userAgent: request.headers.get("user-agent"),
      }),
    ]);

    return Response.json({
      ok: true,
      message: "注册成功，无需短信验证码；已开通3天月卡同等权益体验",
      verificationRequired: false,
      trial: { expiresAt: trialExpiresAt, graceEndsAt: trialGraceEndsAt, entitlement: "monthly" },
    }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "注册失败" }, { status: 500 });
  }
}
