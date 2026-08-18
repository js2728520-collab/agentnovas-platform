import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, authTokens, notificationDeliveries, personalAgentMonthlyPeriods, personalAgents, users } from "@/db/schema";
import { hashPassword, normalizeEmail, randomToken, sha256, validEmail } from "@/lib/auth";
import { calculatePersonalAgentCommission } from "@/lib/business-rules";
import { requireUser, responseError } from "@/lib/session";

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const currentMonth = () => new Date().toISOString().slice(0, 7);
const readMonth = (value: string | null | undefined) => monthPattern.test(value || "") ? value! : currentMonth();

export async function GET(request: Request) {
  try {
    const actor = await requireUser(request, ["hq_admin"]);
    const month = readMonth(new URL(request.url).searchParams.get("month"));
    const db = getDb();
    const [agents, periods] = await Promise.all([
      db.select({
        id: personalAgents.id,
        userId: personalAgents.userId,
        status: personalAgents.status,
        createdAt: personalAgents.createdAt,
        email: users.email,
        nickname: users.nickname,
        userStatus: users.status,
      }).from(personalAgents).innerJoin(users, eq(users.id, personalAgents.userId))
        .orderBy(desc(personalAgents.createdAt)).limit(1000),
      db.select().from(personalAgentMonthlyPeriods).where(eq(personalAgentMonthlyPeriods.month, month)),
    ]);
    const periodMap = new Map(periods.map((period) => [period.agentId, period]));
    const rows = agents.map((agent) => {
      const period = periodMap.get(agent.id);
      const commission = calculatePersonalAgentCommission(Number(period?.performanceUsdt || 0));
      return {
        ...agent,
        month,
        performanceUsdt: commission.performanceUsdt,
        commissionRate: commission.commissionRate,
        commissionUsdt: commission.commissionUsdt,
        periodId: period?.id || null,
      };
    });
    return Response.json({ month, agents: rows, resetPolicy: "每月独立核算，进入新月份后业绩从 0 开始，不结转上月" });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser(request, ["hq_admin"]);
    const body = await request.json() as { email?: string; name?: string };
    const email = normalizeEmail(body.email || "");
    if (!validEmail(email)) return Response.json({ error: "请输入有效邮箱" }, { status: 400 });
    const displayName = body.name?.trim() || email.split("@")[0];
    const db = getDb();
    if ((await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]) {
      return Response.json({ error: "邮箱已存在，不能重复创建个人代理" }, { status: 409 });
    }
    const userId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const month = currentMonth();
    const now = new Date().toISOString();
    const temporaryPassword = randomToken(8);
    const verifyToken = randomToken();
    await db.batch([
      db.insert(users).values({
        id: userId,
        email,
        nickname: displayName,
        passwordHash: await hashPassword(temporaryPassword),
        role: "employee",
        organizationId: actor.organizationId,
        reportsToUserId: actor.id,
        status: "pending",
      }),
      db.insert(personalAgents).values({ id: agentId, userId, organizationId: actor.organizationId, status: "active" }),
      db.insert(personalAgentMonthlyPeriods).values({ id: crypto.randomUUID(), agentId, month, performanceUsdt: 0, commissionRate: .2, commissionUsdt: 0 }),
      db.insert(authTokens).values({ id: crypto.randomUUID(), userId, tokenHash: await sha256(verifyToken), purpose: "verify_email", expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() }),
      db.insert(notificationDeliveries).values({ id: crypto.randomUUID(), userId, channel: "email", category: "login_security", templateKey: "personal_agent_account_invite", payloadJson: JSON.stringify({ verifyToken, temporaryPassword, role: "personal_agent" }), scheduledAt: now }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: actor.id, action: "organization.personal_agent_created", subjectType: "personal_agent", subjectId: agentId, afterJson: JSON.stringify({ userId, email, displayName, month }) }),
    ]);
    return Response.json({ agent: { id: agentId, userId, email, name: displayName, month, performanceUsdt: 0, commissionRate: .2, commissionUsdt: 0, status: "pending" }, message: "个人代理已创建，账户待激活；本月业绩从 0 开始" }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireUser(request, ["hq_admin"]);
    const body = await request.json() as { agentId?: string; month?: string; performanceUsdt?: number };
    const month = readMonth(body.month);
    const performanceUsdt = Number(body.performanceUsdt);
    if (!body.agentId || !Number.isFinite(performanceUsdt) || performanceUsdt < 0) return Response.json({ error: "请输入有效的个人代理业绩和代理ID" }, { status: 400 });
    const db = getDb();
    const agent = (await db.select({ id: personalAgents.id }).from(personalAgents).where(eq(personalAgents.id, body.agentId)).limit(1))[0];
    if (!agent) return Response.json({ error: "个人代理不存在" }, { status: 404 });
    const commission = calculatePersonalAgentCommission(performanceUsdt);
    const existing = (await db.select({ id: personalAgentMonthlyPeriods.id }).from(personalAgentMonthlyPeriods).where(and(eq(personalAgentMonthlyPeriods.agentId, agent.id), eq(personalAgentMonthlyPeriods.month, month))).limit(1))[0];
    const now = new Date().toISOString();
    if (existing) {
      await db.update(personalAgentMonthlyPeriods).set({ performanceUsdt: commission.performanceUsdt, commissionRate: commission.commissionRate, commissionUsdt: commission.commissionUsdt, updatedAt: now }).where(eq(personalAgentMonthlyPeriods.id, existing.id));
    } else {
      await db.insert(personalAgentMonthlyPeriods).values({ id: crypto.randomUUID(), agentId: agent.id, month, performanceUsdt: commission.performanceUsdt, commissionRate: commission.commissionRate, commissionUsdt: commission.commissionUsdt });
    }
    await db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: actor.id, action: "organization.personal_agent_monthly_performance_updated", subjectType: "personal_agent", subjectId: agent.id, afterJson: JSON.stringify({ month, ...commission }) });
    return Response.json({ month, ...commission, message: `${month} 月个人代理业绩已更新，按 ${(commission.commissionRate * 100).toFixed(0)}% 计算` });
  } catch (error) {
    return responseError(error);
  }
}
