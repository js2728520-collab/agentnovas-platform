import assert from "node:assert/strict";
import test from "node:test";

import { commercialPlanDto,cursorPage,databaseMembershipOrderStatus,databasePerformanceStatementStatus,publicMembershipOrderStatus,publicPerformanceStatementStatus } from "../lib/commercial-public-contract.ts";
import { assertOperationsCustomerScope,commercialCustomerScopePredicate } from "../lib/commercial-operations-scope.ts";

test("database workflow states never leak through the public contract",()=>{
  assert.equal(publicMembershipOrderStatus("pending_evidence"),"AWAITING_EVIDENCE");
  assert.equal(publicMembershipOrderStatus("pending_review"),"SUBMITTED");
  assert.equal(publicMembershipOrderStatus("activated"),"ACTIVATED");
  assert.equal(publicPerformanceStatementStatus("pending_review"),"SUBMITTED");
  assert.equal(publicPerformanceStatementStatus("payment_pending"),"INVOICED");
  assert.equal(publicPerformanceStatementStatus("no_fee"),"VOID");
  assert.throws(()=>publicMembershipOrderStatus("approved"),/UNKNOWN_MEMBERSHIP_ORDER_STATUS/);
});

test("plan and cursor DTOs match the commercial beta contract",()=>{
  assert.deepEqual(commercialPlanDto({plan_code:"lifetime_v1",version:1,price_amount:"588.000000000000000000",duration_days:null,ai_credit_grant:"36000",performance_fee_bps:1600,status:"active"}),{code:"lifetime_v1",name:"终身会员",priceUsd:"588.00",priceCurrency:"USD",durationDays:null,aiCredits:36000,performanceFeeRate:"0.16",isLifetime:true,version:1,isActive:true});
  assert.deepEqual(cursorPage([{id:"one"}],25,"next"),{data:[{id:"one"}],page:{nextCursor:"next",hasMore:true,limit:25}});
});

test("public workflow filters map to database states and reject unknown values",()=>{
  assert.equal(databaseMembershipOrderStatus("SUBMITTED"),"pending_review");
  assert.equal(databasePerformanceStatementStatus("INVOICED"),"payment_pending");
  assert.throws(()=>databaseMembershipOrderStatus("pending_review"),error=>error.code==="UNKNOWN_MEMBERSHIP_ORDER_STATUS"&&error.status===422);
  assert.throws(()=>databasePerformanceStatementStatus("payment_pending"),error=>error.code==="UNKNOWN_PERFORMANCE_STATEMENT_STATUS"&&error.status===422);
});

test("commercial operations scope is fail closed until the security resolver is merged",async()=>{
  assert.equal(commercialCustomerScopePredicate().clause,"FALSE");
  await assert.rejects(assertOperationsCustomerScope({},"PLATFORM",{userId:"ops",organizationId:null},"customer"),/尚未接入安全策略/);
});
