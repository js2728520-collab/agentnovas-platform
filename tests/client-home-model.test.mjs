import assert from "node:assert/strict";
import test from "node:test";

const { deriveClientHomeTask, derivePaperPortfolioSummary } = await import("../apps/client/ui/client-home-model.ts");

const activeMembership = {
  id: "membership-1",
  planCode: "monthly_v1",
  status: "ACTIVE",
  startsAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-09-01T00:00:00.000Z",
  closeOnly: false,
};

test("home sends a new customer to membership without claiming disclosure acceptance", () => {
  assert.deepEqual(deriveClientHomeTask({
    canViewMembership: true,
    membership: null,
    latestOrder: null,
    canViewPaper: true,
    portfolios: [],
  }), {
    title: "选择会员计划",
    description: "当前没有有效会员或待处理申请。可先浏览交易大厅，再到会员中心查看计划并提交人工付款申请。",
    href: "/membership",
    action: "进入会员中心",
    state: "ACTION_REQUIRED",
  });
});

test("home never describes a submitted order as activated or paid", () => {
  const task = deriveClientHomeTask({
    canViewMembership: true,
    membership: null,
    latestOrder: { status: "SUBMITTED" },
    canViewPaper: true,
    portfolios: [],
  });
  assert.equal(task.title, "会员申请正在人工复核");
  assert.match(task.description, /不代表付款确认或会员激活/);
  assert.equal(task.state, "IN_REVIEW");
});

test("home flags incomplete paper initialization from server data", () => {
  const task = deriveClientHomeTask({
    canViewMembership: true,
    membership: activeMembership,
    latestOrder: null,
    canViewPaper: true,
    portfolios: [{ status: "ACTIVE" }, { status: "ACTIVE" }],
  });
  assert.equal(task.title, "官方模拟组合尚未完整初始化");
  assert.match(task.description, /2 \/ 3/);
  assert.equal(task.href, "/paper");
});

test("home opens the hall only when all three server portfolios exist", () => {
  const task = deriveClientHomeTask({
    canViewMembership: true,
    membership: activeMembership,
    latestOrder: null,
    canViewPaper: true,
    portfolios: [{ status: "ACTIVE" }, { status: "ACTIVE" }, { status: "READ_ONLY" }],
  });
  assert.equal(task.title, "查看三卡模拟执行证据");
  assert.match(task.description, /2 张允许新开仓 · 1 张只读或仅平仓/);
  assert.match(task.description, /不代表 Worker 正在运行/);
  assert.equal(task.href, "/trading-hall");
});

test("home exposes API failures as errors instead of indefinite loading", () => {
  const task = deriveClientHomeTask({
    canViewMembership: true,
    membership: undefined,
    membershipError: "会员接口暂不可用",
    latestOrder: undefined,
    canViewPaper: true,
    portfolios: undefined,
  });
  assert.equal(task.state, "ERROR");
  assert.match(task.description, /暂不可用/);
});

test("home respects a missing membership permission", () => {
  const task = deriveClientHomeTask({
    canViewMembership: false,
    membership: undefined,
    latestOrder: undefined,
    canViewPaper: false,
    portfolios: undefined,
  });
  assert.equal(task.state, "LIMITED_ACCESS");
  assert.equal(task.href, null);
});

test("home portfolio summary uses only server-returned paper balances", () => {
  assert.deepEqual(derivePaperPortfolioSummary([
    { equityUsdt: "10025.50", realizedNetPnlUsdt: "12.25", unrealizedPnlUsdt: "13.25", status: "ACTIVE", runtime: { state: "ACTIVE" } },
    { equityUsdt: "9980.00", realizedNetPnlUsdt: "-15.00", unrealizedPnlUsdt: "-5.00", status: "CLOSE_ONLY", runtime: { state: "PAUSED" } },
    { equityUsdt: "10010.25", realizedNetPnlUsdt: "0.25", unrealizedPnlUsdt: "10.00", status: "ACTIVE", runtime: { state: "NOT_STARTED" } },
  ]), {
    totalEquityUsdt: 30015.75,
    realizedNetPnlUsdt: -2.5,
    unrealizedPnlUsdt: 18.25,
    activePortfolioCount: 2,
    runningStrategyCount: 1,
  });
});
