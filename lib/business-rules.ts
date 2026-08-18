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

const OPERATING_COST_RATE = .5;
const DISTRIBUTABLE_HEADQUARTERS_RATE = .2;
const DISTRIBUTABLE_BRANCH_RATE = .8;

export function allocateRevenue(amountUsdt: number, confirmedAt: string, attribution: Attribution): Allocation[] {
  if (amountUsdt < 0 || !Number.isFinite(amountUsdt)) throw new Error("Invalid revenue amount");
  const active = attribution.status === "active" && attribution.effectiveAt && confirmedAt >= attribution.effectiveAt;
  if (!active) return [{ beneficiary: "headquarters", rate: 1, amountUsdt: money(amountUsdt) }];

  return [
    { beneficiary: "headquarters", rate: DISTRIBUTABLE_HEADQUARTERS_RATE, amountUsdt: money(amountUsdt * DISTRIBUTABLE_HEADQUARTERS_RATE) },
    { beneficiary: "branch", beneficiaryId: attribution.branchId, rate: DISTRIBUTABLE_BRANCH_RATE, amountUsdt: money(amountUsdt * DISTRIBUTABLE_BRANCH_RATE) },
  ];
}

export function allocateMembershipRevenue(grossAmountUsdt: number, confirmedAt: string, attribution: Attribution): Allocation[] {
  if (grossAmountUsdt < 0 || !Number.isFinite(grossAmountUsdt)) throw new Error("Invalid membership revenue amount");
  const operatingCostUsdt = money(grossAmountUsdt * OPERATING_COST_RATE);
  const distributableRevenueUsdt = money(grossAmountUsdt - operatingCostUsdt);
  const distributableAllocations = allocateRevenue(distributableRevenueUsdt, confirmedAt, attribution);
  if (distributableAllocations.length === 1) {
    return [{ beneficiary: "headquarters", rate: 1, amountUsdt: money(grossAmountUsdt) }];
  }
  return [
    { beneficiary: "headquarters", rate: OPERATING_COST_RATE + OPERATING_COST_RATE * DISTRIBUTABLE_HEADQUARTERS_RATE, amountUsdt: money(operatingCostUsdt + distributableRevenueUsdt * DISTRIBUTABLE_HEADQUARTERS_RATE) },
    { beneficiary: "branch", beneficiaryId: attribution.branchId, rate: OPERATING_COST_RATE * DISTRIBUTABLE_BRANCH_RATE, amountUsdt: money(distributableRevenueUsdt * DISTRIBUTABLE_BRANCH_RATE) },
  ];
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
