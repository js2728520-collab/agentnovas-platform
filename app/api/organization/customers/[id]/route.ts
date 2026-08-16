import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  communityStrategies,
  customerAttributions,
  customerProfiles,
  exchangeAccounts,
  memberships,
  notificationChannels,
  organizations,
  revenueEvents,
  sessions,
  strategySubscriptions,
  trades,
  users,
} from "@/db/schema";
import { canSeeCustomer } from "@/lib/permissions";
import { requireUser, responseError } from "@/lib/session";

const roles = ["hq_admin", "hq_support", "branch_admin", "manager", "supervisor", "employee", "finance", "auditor"] as const;
const attributionPriority: Record<string, number> = { active: 5, review_pending: 4, public_pool_pending: 3, rejected: 2, ended: 1 };

function displayName(row?: { email: string; username: string | null; nickname: string | null }) {
  return row?.nickname || row?.username || row?.email.split("@")[0] || "—";
}

function vipLevel(planCode?: string | null) {
  const code = String(planCode || "").toLowerCase();
  if (!code) return "未开通";
  if (code.includes("trial")) return "体验会员";
  if (code.includes("lifetime") || code.includes("终身")) return "终身会员";
  if (/annual|year|年/.test(code)) return "年度会员";
  if (/quarter|season|季/.test(code)) return "季度会员";
  if (/month|月/.test(code)) return "月度会员";
  return planCode || "未开通";
}

function deviceBrowser(userAgent?: string | null) {
  const ua = String(userAgent || "");
  if (!ua) return "暂无记录";
  const device = /iphone/i.test(ua) ? "iPhone" : /ipad/i.test(ua) ? "iPad" : /android/i.test(ua) ? "Android" : /windows/i.test(ua) ? "Windows" : /macintosh|mac os x/i.test(ua) ? "macOS" : /linux/i.test(ua) ? "Linux" : "未知设备";
  const browser = /edg\//i.test(ua) ? "Edge" : /opr\//i.test(ua) ? "Opera" : /firefox\//i.test(ua) ? "Firefox" : /chrome\//i.test(ua) ? "Chrome" : /safari\//i.test(ua) ? "Safari" : "未知浏览器";
  return `${device} · ${browser}`;
}

function loginType(afterJson?: string | null) {
  if (!afterJson) return "账号密码";
  try {
    const value = JSON.parse(afterJson) as { identifierType?: string };
    return value.identifierType === "phone" ? "手机号 + 密码" : value.identifierType === "email" ? "邮箱 + 密码" : value.identifierType === "username" ? "用户名 + 密码" : "账号密码";
  } catch {
    return "账号密码";
  }
}

function drawdown(rows: Array<{ realizedNetPnlUsdt: number }>) {
  let equity = 0, peak = 0, maximum = 0;
  for (const row of rows) {
    equity += row.realizedNetPnlUsdt;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  }
  return maximum;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser(request, [...roles]);
    const { id } = await params;
    const db = getDb();
    const attributionRows = await db.select({
      customerId: users.id,
      email: users.email,
      phone: users.phone,
      username: users.username,
      nickname: users.nickname,
      status: users.status,
      registeredAt: users.createdAt,
      locale: users.locale,
      timezone: users.timezone,
      source: customerAttributions.source,
      attributionStatus: customerAttributions.status,
      branchId: customerAttributions.branchId,
      managerId: customerAttributions.managerId,
      supervisorId: customerAttributions.supervisorId,
      employeeId: customerAttributions.employeeId,
      effectiveAt: customerAttributions.effectiveAt,
      attributionCreatedAt: customerAttributions.createdAt,
    }).from(customerAttributions)
      .innerJoin(users, eq(users.id, customerAttributions.customerId))
      .where(eq(customerAttributions.customerId, id))
      .orderBy(desc(customerAttributions.createdAt));

    const attribution = [...attributionRows].sort((a, b) => (attributionPriority[b.attributionStatus] || 0) - (attributionPriority[a.attributionStatus] || 0))[0];
    if (!attribution) return Response.json({ error: "客户不存在" }, { status: 404 });
    if (!canSeeCustomer(actor.role, actor.id, actor.organizationId, attribution)) return Response.json({ error: "无权查看该客户" }, { status: 403 });

    const chainIds = [attribution.managerId, attribution.supervisorId, attribution.employeeId].filter((value): value is string => Boolean(value));
    const [profile, membership, channels, firstSession, lastSession, registrationLog, lastLoginLog, financialEvents, branch, people, customerTrades, customerAccounts, subscriptions, strategies] = await Promise.all([
      db.select().from(customerProfiles).where(eq(customerProfiles.customerId, id)).limit(1).then(rows => rows[0]),
      db.select().from(memberships).where(eq(memberships.customerId, id)).orderBy(desc(memberships.createdAt)).limit(1).then(rows => rows[0]),
      db.select({ channel: notificationChannels.channel, destination: notificationChannels.destination, status: notificationChannels.status, verifiedAt: notificationChannels.verifiedAt }).from(notificationChannels).where(eq(notificationChannels.userId, id)),
      db.select({ ipAddress: sessions.ipAddress, userAgent: sessions.userAgent, createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.userId, id)).orderBy(asc(sessions.createdAt)).limit(1).then(rows => rows[0]),
      db.select({ ipAddress: sessions.ipAddress, userAgent: sessions.userAgent, createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.userId, id)).orderBy(desc(sessions.createdAt)).limit(1).then(rows => rows[0]),
      db.select({ ipAddress: auditLogs.ipAddress, createdAt: auditLogs.createdAt }).from(auditLogs).where(and(eq(auditLogs.subjectId, id), eq(auditLogs.action, "customer.registered"))).orderBy(asc(auditLogs.createdAt)).limit(1).then(rows => rows[0]),
      db.select({ ipAddress: auditLogs.ipAddress, userAgent: auditLogs.userAgent, createdAt: auditLogs.createdAt, afterJson: auditLogs.afterJson }).from(auditLogs).where(and(eq(auditLogs.subjectId, id), eq(auditLogs.action, "auth.login"))).orderBy(desc(auditLogs.createdAt)).limit(1).then(rows => rows[0]),
      db.select({ type: revenueEvents.type, amountUsdt: revenueEvents.amountUsdt, status: revenueEvents.status }).from(revenueEvents).where(eq(revenueEvents.customerId, id)),
      attribution.branchId ? db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, attribution.branchId)).limit(1).then(rows => rows[0]) : Promise.resolve(undefined),
      chainIds.length ? db.select({ id: users.id, email: users.email, username: users.username, nickname: users.nickname, role: users.role }).from(users).where(inArray(users.id, chainIds)) : Promise.resolve([]),
      db.select().from(trades).where(eq(trades.customerId, id)).orderBy(asc(trades.closedAt)),
      db.select({ id: exchangeAccounts.id, name: exchangeAccounts.exchange, label: exchangeAccounts.label, environment: exchangeAccounts.environment, status: exchangeAccounts.status }).from(exchangeAccounts).where(eq(exchangeAccounts.customerId, id)),
      db.select().from(strategySubscriptions).where(eq(strategySubscriptions.customerId, id)),
      db.select({ id: communityStrategies.id, name: communityStrategies.name }).from(communityStrategies),
    ]);

    const peopleById = new Map(people.map(person => [person.id, person]));
    const channelMap = new Map(channels.map(channel => [channel.channel, channel]));
    const confirmed = financialEvents.filter(event => event.status === "confirmed");
    const totalRechargeUsdt = confirmed.filter(event => event.type === "membership").reduce((sum, event) => sum + Math.max(0, event.amountUsdt), 0);
    const totalSpentUsdt = confirmed.reduce((sum, event) => event.type === "refund" ? sum - Math.abs(event.amountUsdt) : sum + Math.max(0, event.amountUsdt), 0);
    const login = lastLoginLog || lastSession;
    const closedTrades = customerTrades.filter(trade => trade.closedAt);
    const openTrades = customerTrades.filter(trade => !trade.closedAt);
    const strategyNames = new Map(strategies.map(strategy => [strategy.id, strategy.name]));
    const organizationChain = [
      { role: "总部", name: "AgentNovas 总公司" },
      ...(attribution.branchId ? [{ role: "分公司", name: branch?.name || attribution.branchId }] : [{ role: "归属", name: "总公司公海客户池" }]),
      ...([attribution.managerId, attribution.supervisorId, attribution.employeeId] as Array<string | null>).flatMap((personId, index) => {
        if (!personId) return [];
        const person = peopleById.get(personId);
        return [{ role: ["经理", "主管", "员工"][index], name: displayName(person), id: personId }];
      }),
    ];
    const directOwnerId = attribution.employeeId || attribution.supervisorId || attribution.managerId;
    const directOwner = directOwnerId ? peopleById.get(directOwnerId) : undefined;

    return Response.json({
      customerId: attribution.customerId,
      displayName: profile?.displayName || attribution.nickname || attribution.username || attribution.email.split("@")[0],
      registeredAt: attribution.registeredAt,
      status: attribution.status,
      account: {
        registrationIp: registrationLog?.ipAddress || firstSession?.ipAddress || null,
        username: attribution.username,
        phone: attribution.phone,
        email: attribution.email,
        telegram: channelMap.get("telegram") || null,
        whatsapp: channelMap.get("whatsapp") || null,
        locale: attribution.locale,
        timezone: attribution.timezone,
      },
      membership: membership ? { planCode: membership.planCode, vipLevel: vipLevel(membership.planCode), status: membership.status, startsAt: membership.startsAt, expiresAt: membership.expiresAt } : { planCode: null, vipLevel: "未开通", status: "none", startsAt: null, expiresAt: null },
      financials: { pointsBalance: null, pointsLedgerConnected: false, totalRechargeUsdt: Number(totalRechargeUsdt.toFixed(2)), totalSpentUsdt: Number(Math.max(0, totalSpentUsdt).toFixed(2)) },
      login: { type: loginType(lastLoginLog?.afterJson), ipAddress: login?.ipAddress || null, lastLoginAt: login?.createdAt || null, deviceBrowser: deviceBrowser(login?.userAgent), userAgent: login?.userAgent || null },
      attribution: { source: attribution.source, status: attribution.attributionStatus, effectiveAt: attribution.effectiveAt, directOwner: directOwner ? { id: directOwner.id, role: directOwner.role, name: displayName(directOwner) } : null },
      organizationChain,
      contactNote: profile?.contactNote || "",
      exchanges: customerAccounts,
      following: subscriptions.filter(subscription => ["active", "paused", "pending"].includes(subscription.status)).map(subscription => ({ id: subscription.strategyId, name: strategyNames.get(subscription.strategyId) || "未知策略", status: subscription.status })),
      metrics: {
        principal: openTrades.reduce((sum, trade) => sum + trade.entryValueUsdt, 0),
        realizedPnl: closedTrades.reduce((sum, trade) => sum + trade.realizedNetPnlUsdt, 0),
        openPositions: openTrades.length,
        totalTrades: customerTrades.length,
        closedTrades: closedTrades.length,
        winRate: closedTrades.length ? closedTrades.filter(trade => trade.realizedNetPnlUsdt > 0).length / closedTrades.length * 100 : 0,
        maxDrawdown: drawdown(closedTrades),
        fees: customerTrades.reduce((sum, trade) => sum + trade.feesUsdt + trade.fundingUsdt, 0),
      },
    });
  } catch (error) {
    return responseError(error);
  }
}
