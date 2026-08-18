import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { personalAgentMonthlyPeriods, personalAgents, revenueAllocations, revenueEvents, users } from "@/db/schema";
import { allocateHeadquartersDepartments, headquartersDepartmentRates, personalAgentCommissionTiers } from "@/lib/business-rules";
import { requireUser, responseError } from "@/lib/session";

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export async function GET(request: Request) {
  try {
    const actor = await requireUser(request, ["branch_admin", "employee"]);
    const db = getDb();
    const isPersonalAgent = actor.role === "employee" && Boolean((await db.select({ id: personalAgents.id }).from(personalAgents).where(and(eq(personalAgents.userId, actor.id), eq(personalAgents.status, "active"))).limit(1))[0]);
    if (actor.role !== "branch_admin" && !isPersonalAgent) return Response.json({ error: "月度分红仅对分公司和个人代理开放" }, { status: 403 });
    const url = new URL(request.url);
    const month = monthPattern.test(url.searchParams.get("month") || "") ? url.searchParams.get("month")! : new Date().toISOString().slice(0, 7);
    const start = `${month}-01T00:00:00.000Z`;
    const next = new Date(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const end = next.toISOString();
    const scopeIds = [actor.id, actor.organizationId].filter((value): value is string => Boolean(value));
    const scopedRows = scopeIds.length ? await db.select({
      eventType: revenueEvents.type,
      beneficiaryType: revenueAllocations.beneficiaryType,
      beneficiaryId: revenueAllocations.beneficiaryId,
      allocatedAmount: revenueAllocations.amountUsdt,
    }).from(revenueAllocations).innerJoin(revenueEvents, eq(revenueEvents.id, revenueAllocations.revenueEventId))
      .where(and(
        gte(revenueEvents.confirmedAt, start),
        lt(revenueEvents.confirmedAt, end),
        eq(revenueEvents.status, "confirmed"),
        inArray(revenueAllocations.beneficiaryId, scopeIds),
      )) : [];
    const allocationMap = new Map<string, { beneficiaryType: string; beneficiaryId: string | null; amount: number }>();
    const eventTotals = new Map<string, number>();
    for (const row of scopedRows) {
      const allocatedAmount = Number(row.allocatedAmount || 0);
      eventTotals.set(row.eventType, Number(eventTotals.get(row.eventType) || 0) + allocatedAmount);
      const key = `${row.beneficiaryType}:${row.beneficiaryId || ""}`;
      const current = allocationMap.get(key);
      allocationMap.set(key, { beneficiaryType: row.beneficiaryType, beneficiaryId: row.beneficiaryId, amount: Number(current?.amount || 0) + allocatedAmount });
    }
    const events = [...eventTotals.entries()].map(([type, amount]) => ({ type, amount: money(amount) }));
    const allocations = [...allocationMap.values()].map((row) => ({ ...row, amount: money(row.amount) }));

    const totalRevenue = money(events.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const membershipRevenue = money(events.filter((row) => row.type === "membership").reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const departmentAllocations: ReturnType<typeof allocateHeadquartersDepartments> = [];
    const personalAgentRows = isPersonalAgent ? await db.select({
      agentId: personalAgents.id,
      email: users.email,
      nickname: users.nickname,
      status: personalAgents.status,
      performanceUsdt: personalAgentMonthlyPeriods.performanceUsdt,
      commissionRate: personalAgentMonthlyPeriods.commissionRate,
      commissionUsdt: personalAgentMonthlyPeriods.commissionUsdt,
    }).from(personalAgentMonthlyPeriods)
      .innerJoin(personalAgents, eq(personalAgents.id, personalAgentMonthlyPeriods.agentId))
      .innerJoin(users, eq(users.id, personalAgents.userId))
      .where(and(eq(personalAgentMonthlyPeriods.month, month), eq(personalAgents.userId, actor.id))).orderBy(desc(personalAgentMonthlyPeriods.commissionUsdt)) : [];
    const personalAgentCommissionTotal = money(personalAgentRows.reduce((sum, row) => sum + Number(row.commissionUsdt || 0), 0));

    return Response.json({
      scope: isPersonalAgent ? "personal_agent" : "branch",
      month,
      revenue: events,
      allocations,
      summary: {
        totalRevenue,
        membershipRevenue,
        operatingCost: 0,
        websiteRevenue: totalRevenue,
        headquartersWebsiteShare: 0,
        branchWebsiteShare: actor.role === "branch_admin" ? totalRevenue : 0,
        personalAgentCommissionTotal,
      },
      departmentAllocations,
      headquartersDepartmentRates,
      personalAgentCommissionTiers,
      personalAgents: personalAgentRows,
      personalAgentResetPolicy: "每月独立核算，进入新月份后业绩从 0 开始，不结转上月",
    });
  } catch (error) {
    return responseError(error);
  }
}
