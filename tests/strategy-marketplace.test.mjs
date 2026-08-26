import assert from"node:assert/strict";import test from"node:test";import{readFile}from"node:fs/promises";import{splitStrategyPerformanceFee}from"../lib/strategy-marketplace.ts";import{allocateRevenue}from"../packages/domain/src/business-rules.ts";
test("strategy fee creates author and organization earnings only after collection",()=>{assert.deepEqual(splitStrategyPerformanceFee(20,"pending"),{grossPerformanceFeeUsdt:20,platformFeeUsdt:0,authorAmountUsdt:0,eligibleRevenueUsdt:0});const split=splitStrategyPerformanceFee(20,"confirmed");assert.deepEqual(split,{grossPerformanceFeeUsdt:20,platformFeeUsdt:10,authorAmountUsdt:10,eligibleRevenueUsdt:10});const rows=allocateRevenue(split.eligibleRevenueUsdt,"2026-08-03T00:00:00Z",{status:"active",effectiveAt:"2026-08-02T00:00:00Z",branchId:"b",managerId:"m",supervisorId:"s",employeeId:"e"});assert.deepEqual(rows.map(x=>x.amountUsdt),[1,8,.2,.3,.5])});
test("self-use strategies do not create platform revenue",()=>{assert.deepEqual(splitStrategyPerformanceFee(20,"confirmed","self_use"),{grossPerformanceFeeUsdt:20,platformFeeUsdt:0,authorAmountUsdt:20,eligibleRevenueUsdt:0})});
// 原本这里断言的是「投稿不检查任何前置报告」。那条契约成立于 P-05 尚未冻结时——门槛
// 数值未定，代码里没有可依据的标准，于是把关只能交给人工审核。P-05 现已冻结（180 天
// 回测、30 笔成交、收益为正、按档位的回撤上限），PRD 6.5 明确要求「不得用口头结论
// 替代」，因此投稿必须先过确定性判定。契约本身变了，不是写法变了。
test("strategy submission enforces the frozen P-05 admission thresholds",async()=>{const source=await readFile(new URL("../app/api/strategy-marketplace/[id]/submit/route.client.ts",import.meta.url),"utf8");assert.match(source,/evaluateAndRecordAdmission/);assert.match(source,/STRATEGY_ADMISSION_NOT_MET/);
  // 未达标时返回的是哪几条不达标，而不是一句「不符合要求」——作者要能知道差在哪里。
  assert.match(source,/failedChecks: admission\.result\.failedCheckIds/);
  // 状态迁移交给状态机，不再是路由里的一句 includes。
  assert.match(source,/applyStrategyListingTransition/);assert.doesNotMatch(source,/\["draft", "testing", "rejected"\]\.includes/)});
test("self-use strategy can explicitly switch to marketplace submission",async()=>{const source=await readFile(new URL("../app/api/strategy-marketplace/[id]/submit/route.client.ts",import.meta.url),"utf8");assert.match(source,/shareToMarketplace/);assert.match(source,/publicationMode:\s*"marketplace"/);assert.match(source,/strategy\.publicationMode === "self_use" && !shareToMarketplace/)});
