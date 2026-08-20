import assert from "node:assert/strict";
import test from "node:test";

import { publicMembershipOrderStatus,publicPerformanceStatementStatus } from "../lib/commercial-public-contract.ts";
import { assertOperationsCustomerScope,commercialCustomerScopePredicate } from "../lib/commercial-operations-scope.ts";

test("database workflow states never leak through the public contract",()=>{
  assert.equal(publicMembershipOrderStatus("pending_evidence"),"awaitingPaymentEvidence");
  assert.equal(publicMembershipOrderStatus("pending_review"),"awaitingApproval");
  assert.equal(publicMembershipOrderStatus("activated"),"activated");
  assert.equal(publicPerformanceStatementStatus("pending_review"),"awaitingAssessment");
  assert.equal(publicPerformanceStatementStatus("payment_pending"),"awaitingPaymentConfirmation");
  assert.throws(()=>publicMembershipOrderStatus("approved"),/UNKNOWN_MEMBERSHIP_ORDER_STATUS/);
});

test("commercial operations scope is fail closed until the security resolver is merged",async()=>{
  assert.equal(commercialCustomerScopePredicate().clause,"FALSE");
  await assert.rejects(assertOperationsCustomerScope({},"PLATFORM",{userId:"ops",organizationId:null},"customer"),/尚未接入安全策略/);
});
