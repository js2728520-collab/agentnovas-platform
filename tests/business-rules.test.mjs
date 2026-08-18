import assert from "node:assert/strict";
import test from "node:test";
import { allocateHeadquartersDepartments, allocateMembershipRevenue, allocateRevenue, calculatePersonalAgentCommission, calculatePerformanceFee, canDisableNotification, headquartersDepartmentRates } from "../lib/business-rules.ts";
import { collectionState } from "../lib/collection-rules.ts";
import { canSeeCustomer } from "../lib/permissions.ts";

test("public pool revenue is 100% headquarters and never backdated", () => {
  assert.deepEqual(allocateRevenue(100, "2026-08-01T00:00:00Z", { status: "public_pool_pending" }), [{ beneficiary: "headquarters", rate: 1, amountUsdt: 100 }]);
  assert.deepEqual(allocateRevenue(100, "2026-08-01T00:00:00Z", { status: "active", effectiveAt: "2026-08-02T00:00:00Z" }), [{ beneficiary: "headquarters", rate: 1, amountUsdt: 100 }]);
});

test("active attribution allocates website revenue 20/80", () => {
  const rows = allocateRevenue(100, "2026-08-03T00:00:00Z", { status: "active", effectiveAt: "2026-08-02T00:00:00Z", branchId: "b", managerId: "m", supervisorId: "s", employeeId: "e" });
  assert.deepEqual(rows.map(x => x.amountUsdt), [20, 80]);
});

test("membership revenue keeps 50% operating cost and splits the remaining 50% 20/80", () => {
  const rows = allocateMembershipRevenue(100, "2026-08-03T00:00:00Z", { status: "active", effectiveAt: "2026-08-02T00:00:00Z", branchId: "b" });
  assert.deepEqual(rows.map(x => x.amountUsdt), [60, 40]);
  assert.deepEqual(allocateMembershipRevenue(100, "2026-08-01T00:00:00Z", { status: "public_pool_pending" }), [{ beneficiary: "headquarters", rate: 1, amountUsdt: 100 }]);
});

test("headquarters departments consume exactly the agreed 20% share", () => {
  assert.equal(headquartersDepartmentRates.reduce((sum, row) => sum + row.rate, 0), .2);
  assert.deepEqual(allocateHeadquartersDepartments(100), [
    { code: "technology", label: "技术部", rate: .025, amountUsdt: 2.5 },
    { code: "business_development", label: "招商部", rate: .025, amountUsdt: 2.5 },
    { code: "operations", label: "运营部", rate: .15, amountUsdt: 15 },
  ]);
});

test("personal agent commission tiers reset by month and respect boundaries", () => {
  assert.equal(calculatePersonalAgentCommission(999.99).commissionRate, .2);
  assert.equal(calculatePersonalAgentCommission(1000).commissionRate, .25);
  assert.equal(calculatePersonalAgentCommission(4999.99).commissionRate, .25);
  assert.equal(calculatePersonalAgentCommission(5000).commissionRate, .3);
  assert.equal(calculatePersonalAgentCommission(10000).commissionRate, .35);
  assert.equal(calculatePersonalAgentCommission(20000).commissionRate, .4);
  assert.deepEqual(calculatePersonalAgentCommission(50000), { period: "monthly", performanceUsdt: 50000, commissionRate: .5, commissionUsdt: 25000, resetAtMonthEnd: true });
});

test("weekly performance fee charges only positive realized profit", () => {
  assert.deepEqual(calculatePerformanceFee({ weeklyRealizedNetPnlUsdt: 1100, membershipPlanCode: "annual" }), { period: "weekly", feeRate: .18, chargeableProfitUsdt: 1100, feeUsdt: 198, carryForwardLoss: 0 });
  assert.equal(calculatePerformanceFee({ weeklyRealizedNetPnlUsdt: -50, membershipPlanCode: "annual" }).feeUsdt, 0);
});

test("mandatory collection notifications cannot be disabled", () => assert.equal(canDisableNotification("performance_fee_collection"), false));
test("collection stops new entries only after grace ends",()=>{assert.equal(collectionState("2026-08-08","2026-08-07","2026-08-09","payment_period").status,"grace");assert.deepEqual(collectionState("2026-08-10","2026-08-07","2026-08-09","grace"),{status:"trading_stopped",newEntriesAllowed:false})});

test("organization roles see their complete downward customer scope", () => {
  const employeeCustomer = { branchId: "branch-a", managerId: "manager-a", supervisorId: "supervisor-a", employeeId: "employee-a" };
  const supervisorDirectCustomer = { branchId: "branch-a", managerId: "manager-a", supervisorId: "supervisor-a", employeeId: null };
  assert.equal(canSeeCustomer("employee", "employee-a", null, employeeCustomer), true);
  assert.equal(canSeeCustomer("supervisor", "supervisor-a", null, employeeCustomer), true);
  assert.equal(canSeeCustomer("supervisor", "supervisor-a", null, supervisorDirectCustomer), true);
  assert.equal(canSeeCustomer("manager", "manager-a", null, employeeCustomer), true);
  assert.equal(canSeeCustomer("branch_admin", "branch-admin", "branch-a", employeeCustomer), true);
  assert.equal(canSeeCustomer("supervisor", "supervisor-b", null, employeeCustomer), false);
  assert.equal(canSeeCustomer("branch_admin", "branch-admin", "branch-b", employeeCustomer), false);
});
