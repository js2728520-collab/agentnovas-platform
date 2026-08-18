export type Attribution = {
  status: "public_pool_pending" | "active";
  effectiveAt?: string;
  branchId?: string;
  managerId?: string;
  supervisorId?: string;
  employeeId?: string;
};

export type Allocation = { beneficiary: "headquarters" | "branch" | "manager" | "supervisor" | "employee"; beneficiaryId?: string; rate: number; amountUsdt: number };

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function allocateRevenue(amountUsdt: number, confirmedAt: string, attribution: Attribution): Allocation[] {
  if (amountUsdt < 0 || !Number.isFinite(amountUsdt)) throw new Error("Invalid revenue amount");
  const active = attribution.status === "active" && attribution.effectiveAt && confirmedAt >= attribution.effectiveAt;
  if (!active) return [{ beneficiary: "headquarters", rate: 1, amountUsdt: money(amountUsdt) }];

  const result: Allocation[] = [
    { beneficiary: "headquarters", rate: .1, amountUsdt: money(amountUsdt * .1) },
    { beneficiary: "branch", beneficiaryId: attribution.branchId, rate: .8, amountUsdt: money(amountUsdt * .8) },
  ];
  if (attribution.employeeId) result.push(
    { beneficiary: "manager", beneficiaryId: attribution.managerId, rate: .02, amountUsdt: money(amountUsdt * .02) },
    { beneficiary: "supervisor", beneficiaryId: attribution.supervisorId, rate: .03, amountUsdt: money(amountUsdt * .03) },
    { beneficiary: "employee", beneficiaryId: attribution.employeeId, rate: .05, amountUsdt: money(amountUsdt * .05) },
  ); else if (attribution.supervisorId) result.push(
    { beneficiary: "manager", beneficiaryId: attribution.managerId, rate: .02, amountUsdt: money(amountUsdt * .02) },
    { beneficiary: "supervisor", beneficiaryId: attribution.supervisorId, rate: .08, amountUsdt: money(amountUsdt * .08) },
  ); else result.push({ beneficiary: "manager", beneficiaryId: attribution.managerId, rate: .1, amountUsdt: money(amountUsdt * .1) });
  return result;
}

export function calculatePerformanceFee(input: {
  weeklyRealizedNetPnlUsdt?: number;
  realizedNetPnlUsdt?: number;
  membershipPlanCode?: string;
}) {
  const weeklyProfitUsdt = Number(input.weeklyRealizedNetPnlUsdt ?? input.realizedNetPnlUsdt ?? 0);
  if (!Number.isFinite(weeklyProfitUsdt)) throw new Error("Invalid weekly profit amount");
  const chargeableProfitUsdt = Math.max(0, weeklyProfitUsdt);
  const planCode = String(input.membershipPlanCode || "").toLowerCase();
  const feeRate = planCode.includes("lifetime") || planCode.includes("终身")
    ? .16
    : /annual|year|年/.test(planCode)
      ? .18
      : /quarter|season|季/.test(planCode)
        ? .19
        : .2;
  return {
    period: "weekly" as const,
    feeRate,
    chargeableProfitUsdt: money(chargeableProfitUsdt),
    feeUsdt: money(chargeableProfitUsdt * feeRate),
    // Loss weeks create no fee and are not carried forward as a recovery hurdle.
    carryForwardLoss: 0,
  };
}

export const mandatoryNotificationCategories = new Set(["membership_billing", "performance_fee_collection", "grace_period_stop", "api_security", "trading_suspended", "login_security", "withdrawal_settlement", "risk_circuit_breaker", "strategy_lifecycle"]);

export function canDisableNotification(category: string) { return !mandatoryNotificationCategories.has(category); }
