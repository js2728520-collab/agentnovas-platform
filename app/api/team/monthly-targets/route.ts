import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, customerAttributions, memberships, monthlyTeamTargets, targetFollowUps, users } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { canAccessCustomerAttribution } from "@/lib/operations-access";
import { responseError } from "@/lib/session";

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const countPlan = (code: string, kind: "monthly" | "quarterly" | "annual") => {
  const value = code.toLowerCase();
  return kind === "monthly" ? /month|monthly|月/.test(value) : kind === "quarterly" ? /quarter|season|季/.test(value) : /annual|year|年/.test(value);
};

function monthBounds(month: string) {
  const start = `${month}-01T00:00:00.000Z`, date = new Date(start);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { start, end: date.toISOString() };
}

function percent(done: number, target: number) { return target > 0 ? Math.min(100, Math.round(done / target * 100)) : 0; }
function overallProgress(actual: Record<string, number>, goals: Record<string, number>) {
  const keys = ["newCustomers", "monthlyCards", "quarterlyCards", "annualCards"];
  const active = keys.filter(key => goals[key] > 0);
  return active.length ? Math.round(active.reduce((sum, key) => sum + Math.min(100, actual[key] / goals[key] * 100), 0) / active.length) : 0;
}

export async function GET(request: Request) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.team.view");
    const url = new URL(request.url), requested = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    const month = monthPattern.test(requested) ? requested : new Date().toISOString().slice(0, 7), { start, end } = monthBounds(month), db = getDb();
    const [allUsers, attributions, allMemberships, allTargets, followUps] = await Promise.all([
      db.select({ id: users.id, email: users.email, role: users.role, organizationId: users.organizationId, reportsToUserId: users.reportsToUserId, createdAt: users.createdAt }).from(users),
      db.select().from(customerAttributions).where(eq(customerAttributions.status, "active")),
      db.select().from(memberships),
      db.select().from(monthlyTeamTargets).where(eq(monthlyTeamTargets.month, month)),
      db.select().from(targetFollowUps).where(eq(targetFollowUps.month, month)),
    ]);
    const userMap = new Map(allUsers.map(x => [x.id, x]));
    const isDescendant = (id: string, ancestor: string) => { let current = userMap.get(id), depth = 0; while (current?.reportsToUserId && depth++ < 6) { if (current.reportsToUserId === ancestor) return true; current = userMap.get(current.reportsToUserId); } return false; };
    const visibleStaff = allUsers.filter(u => {
      if (u.organizationId !== actor.organizationId || !["manager", "supervisor", "employee"].includes(u.role)) return false;
      if (actor.role === "branch_admin") return true;
      if (u.id === actor.id) return true;
      return isDescendant(u.id, actor.id);
    });
    const staffRows = visibleStaff.map(staff => {
      const customerRows = attributions.filter(a => canAccessCustomerAttribution(scope, { userId: staff.id, organizationId: staff.organizationId }, a, organizationIds));
      const customerIds = new Set(customerRows.map(a => a.customerId));
      const newCustomers = [...customerIds].filter(id => { const customer = userMap.get(id); return !!customer && customer.createdAt >= start && customer.createdAt < end; }).length;
      const opened = allMemberships.filter(m => customerIds.has(m.customerId) && !!m.startsAt && m.startsAt >= start && m.startsAt < end && ["active", "grace", "read_only", "expired"].includes(m.status));
      const actual = { newCustomers, monthlyCards: opened.filter(m => countPlan(m.planCode, "monthly")).length, quarterlyCards: opened.filter(m => countPlan(m.planCode, "quarterly")).length, annualCards: opened.filter(m => countPlan(m.planCode, "annual")).length };
      const target = allTargets.find(t => t.assigneeUserId === staff.id);
      const goals = { newCustomers: target?.newCustomersTarget || 0, monthlyCards: target?.monthlyCardsTarget || 0, quarterlyCards: target?.quarterlyCardsTarget || 0, annualCards: target?.annualCardsTarget || 0 };
      return { userId: staff.id, email: staff.email.replace(/^(.{2}).*(@.*)$/, "$1***$2"), role: staff.role, assigned: !!target, actual, goals, overallProgress: overallProgress(actual, goals), progress: { newCustomers: percent(actual.newCustomers, goals.newCustomers), monthlyCards: percent(actual.monthlyCards, goals.monthlyCards), quarterlyCards: percent(actual.quarterlyCards, goals.quarterlyCards), annualCards: percent(actual.annualCards, goals.annualCards) }, note: target?.note || "" };
    }).sort((a, b) => b.overallProgress - a.overallProgress).map((row, index) => ({ ...row, rank: index + 1 }));
    const actorCustomers = new Set(attributions.filter(a => canAccessCustomerAttribution(scope, { userId: actor.id, organizationId: actor.organizationId }, a, organizationIds)).map(a => a.customerId));
    const actorOpened = allMemberships.filter(m => actorCustomers.has(m.customerId) && !!m.startsAt && m.startsAt >= start && m.startsAt < end && ["active", "grace", "read_only", "expired"].includes(m.status));
    const totals = { newCustomers: [...actorCustomers].filter(id => { const customer = userMap.get(id); return !!customer && customer.createdAt >= start && customer.createdAt < end; }).length, monthlyCards: actorOpened.filter(m => countPlan(m.planCode, "monthly")).length, quarterlyCards: actorOpened.filter(m => countPlan(m.planCode, "quarterly")).length, annualCards: actorOpened.filter(m => countPlan(m.planCode, "annual")).length };
    const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const timeProgress = month === new Date().toISOString().slice(0, 7) ? Math.min(100, Math.round(new Date().getDate() / daysInMonth * 100)) : month < new Date().toISOString().slice(0, 7) ? 100 : 0;
    const alerts = staffRows.filter(row => row.userId !== actor.id && (!row.assigned || row.overallProgress + 10 < timeProgress)).map(row => { const type = row.assigned ? "behind_schedule" : "target_missing", handled = followUps.find(item => item.subjectUserId === row.userId && item.alertType === type && item.status === "resolved"); return ({ userId: row.userId, email: row.email, type, message: row.assigned ? `综合完成率 ${row.overallProgress}%，低于时间进度 ${timeProgress}%` : "本月尚未设置任务目标", resolved: !!handled, followUpNote: handled?.note || "", handledAt: handled?.handledAt || null }); }).filter(item => !item.resolved);
    return Response.json({ month, canAssign: actor.role === "manager", timeProgress, summary: { visibleStaff: staffRows.length, assignedStaff: staffRows.filter(row => row.assigned).length, unassignedStaff: staffRows.filter(row => !row.assigned && row.userId !== actor.id).length, attentionStaff: alerts.length, ...totals }, alerts, staff: staffRows });
  } catch (error) { return responseError(error); }
}

export async function POST(request: Request) {
  try {
    const { user: actor } = await requireAccessPermission(request, "ops.team.manage"), body = await request.json() as { month?: string; assigneeUserId?: string; newCustomersTarget?: number; monthlyCardsTarget?: number; quarterlyCardsTarget?: number; annualCardsTarget?: number; note?: string };
    if (!body.month || !monthPattern.test(body.month) || !body.assigneeUserId) return Response.json({ error: "请选择月份和下属成员" }, { status: 400 });
    const values = [body.newCustomersTarget, body.monthlyCardsTarget, body.quarterlyCardsTarget, body.annualCardsTarget].map(v => Number(v || 0));
    if (values.some(v => !Number.isInteger(v) || v < 0 || v > 100000)) return Response.json({ error: "任务指标必须是非负整数" }, { status: 400 });
    const db = getDb(), people = await db.select({ id: users.id, role: users.role, organizationId: users.organizationId, reportsToUserId: users.reportsToUserId }).from(users), map = new Map(people.map(x => [x.id, x])), target = map.get(body.assigneeUserId);
    let current = target, allowed = false, depth = 0; while (current?.reportsToUserId && depth++ < 6) { if (current.reportsToUserId === actor.id) { allowed = true; break; } current = map.get(current.reportsToUserId); }
    if (!target || target.organizationId !== actor.organizationId || !["supervisor", "employee"].includes(target.role) || !allowed) return Response.json({ error: "只能给自己团队的主管或员工分配任务" }, { status: 403 });
    const row = { id: crypto.randomUUID(), month: body.month, branchId: actor.organizationId!, assignedByUserId: actor.id, assigneeUserId: target.id, newCustomersTarget: values[0], monthlyCardsTarget: values[1], quarterlyCardsTarget: values[2], annualCardsTarget: values[3], note: body.note?.trim() || "", updatedAt: new Date().toISOString() };
    const previous = (await db.select().from(monthlyTeamTargets).where(and(eq(monthlyTeamTargets.assigneeUserId, target.id), eq(monthlyTeamTargets.month, body.month))).limit(1))[0];
    await db.batch([
      db.insert(monthlyTeamTargets).values(row).onConflictDoUpdate({ target: [monthlyTeamTargets.assigneeUserId, monthlyTeamTargets.month], set: { assignedByUserId: actor.id, newCustomersTarget: row.newCustomersTarget, monthlyCardsTarget: row.monthlyCardsTarget, quarterlyCardsTarget: row.quarterlyCardsTarget, annualCardsTarget: row.annualCardsTarget, note: row.note, updatedAt: row.updatedAt } }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: actor.id, action: previous ? "monthly_target.updated" : "monthly_target.created", subjectType: "monthly_team_target", subjectId: previous?.id || row.id, beforeJson: previous ? JSON.stringify(previous) : null, afterJson: JSON.stringify({ month: row.month, assigneeUserId: row.assigneeUserId, newCustomersTarget: row.newCustomersTarget, monthlyCardsTarget: row.monthlyCardsTarget, quarterlyCardsTarget: row.quarterlyCardsTarget, annualCardsTarget: row.annualCardsTarget, note: row.note }), ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") }),
    ]);
    return Response.json({ message: "月度任务已保存", month: body.month, assigneeUserId: target.id });
  } catch (error) { return responseError(error); }
}
