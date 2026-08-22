import assert from "node:assert/strict";
import test from "node:test";
import { allocateRevenue, calculatePerformanceFee, canDisableNotification } from "../lib/business-rules.ts";
import { collectionState } from "../lib/collection-rules.ts";
import { canSeeCustomer } from "../lib/permissions.ts";

test("public pool revenue is 100% headquarters and never backdated", () => {
  assert.deepEqual(allocateRevenue(100, "2026-08-01T00:00:00Z", { status: "public_pool_pending" }), [{ beneficiary: "headquarters", rate: 1, amountUsdt: 100 }]);
  assert.deepEqual(allocateRevenue(100, "2026-08-01T00:00:00Z", { status: "active", effectiveAt: "2026-08-02T00:00:00Z" }), [{ beneficiary: "headquarters", rate: 1, amountUsdt: 100 }]);
});

test("employee attribution allocates 10/80/2/3/5", () => {
  const rows = allocateRevenue(100, "2026-08-03T00:00:00Z", { status: "active", effectiveAt: "2026-08-02T00:00:00Z", branchId: "b", managerId: "m", supervisorId: "s", employeeId: "e" });
  assert.deepEqual(rows.map(x => x.amountUsdt), [10, 80, 2, 3, 5]);
});

test("weekly performance fee charges positive realized profit using the membership rate", () => {
  assert.deepEqual(calculatePerformanceFee({ weeklyRealizedNetPnlUsdt: 1100, membershipPlanCode: "annual" }), {
    period: "weekly", feeRate: .2, chargeableProfitUsdt: 1100, feeUsdt: 220, carryForwardLoss: 0,
  });
  assert.deepEqual(calculatePerformanceFee({ weeklyRealizedNetPnlUsdt: 100, membershipPlanCode: "lifetime" }), {
    period: "weekly", feeRate: .16, chargeableProfitUsdt: 100, feeUsdt: 16, carryForwardLoss: 0,
  });
  assert.equal(calculatePerformanceFee({ weeklyRealizedNetPnlUsdt: -50 }).feeUsdt, 0);
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
