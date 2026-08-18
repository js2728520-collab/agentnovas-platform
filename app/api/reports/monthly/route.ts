import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { personalAgentMonthlyPeriods, personalAgents, revenueAllocations, revenueEvents, users } from "@/db/schema";
import { allocateHeadquartersDepartments, headquartersDepartmentRates, personalAgentCommissionTiers } from "@/lib/business-rules";
import { requireUser, responseError } from "@/lib/session";

const roles = ["hq_admin", "branch_admin", "manager", "supervisor", "employee", "finance", "auditor"] as const;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export async function GET(request: Request) {
  try {
    const actor = await requireUser(request, [...roles]);
    const url = new URL(request.url);
    const month = monthPattern.test(url.searchParams.get("month") || "") ? url.searchParams.get("month")! : new Date().toISOString().slice(0, 7);
    const start = `${month}-01T00:00:00.000Z`;
    const next = new Date(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const end = next.toISOString();
    const db = getDb();
    const events = await db.select({
      type: revenueEvents.type,
      amount: sql<number>`sum(${revenueEvents.amountUsdt})`,
    }).from(revenueEvents).where(and(gte(revenueEvents.confirmedAt, start), lt(revenueEvents.confirmedAt, end), eq(revenueEvents.status, "confirmed"))).groupBy(revenueEvents.type);
    let allocations = await db.select({
      beneficiaryType: revenueAllocations.beneficiaryType,
      beneficiaryId: revenueAllocations.beneficiaryId,
      amount: sql<number>`sum(${revenueAllocations.amountUsdt})`,
    }).from(revenueAllocations).innerJoin(revenueEvents, eq(revenueEvents.id, revenueAllocations.revenueEventId))
      .where(and(gte(revenueEvents.confirmedAt, start), lt(revenueEvents.confirmedAt, end), eq(revenueEvents.status, "confirmed")))
      .groupBy(revenueAllocations.beneficiaryType, revenueAllocations.beneficiaryId);
    if (actor.role !== "hq_admin") allocations = allocations.filter((row) => row.beneficiaryId === actor.id || row.beneficiaryId === actor.organizationId);

    const totalRevenue = money(events.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const membershipRevenue = money(events.filter((row) => row.type === "membership").reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const operatingCost = money(membershipRevenue * .5);
    const websiteRevenue = money(Math.max(0, totalRevenue - operatingCost));
    const departmentAllocations = allocateHeadquartersDepartments(websiteRevenue);
    const personalAgentRows = actor.role === "hq_admin" ? await db.select({
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
      .where(eq(personalAgentMonthlyPeriods.month, month)).orderBy(desc(personalAgentMonthlyPeriods.commissionUsdt)) : [];
    const personalAgentCommissionTotal = money(personalAgentRows.reduce((sum, row) => sum + Number(row.commissionUsdt || 0), 0));

    return Response.json({
      month,
      revenue: events,
      allocations,
      summary: {
        totalRevenue,
        membershipRevenue,
        operatingCost,
        websiteRevenue,
        headquartersWebsiteShare: money(websiteRevenue * .2),
        branchWebsiteShare: money(websiteRevenue * .8),
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
