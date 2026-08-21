import assert from "node:assert/strict";
import test from "node:test";

const { deriveClientHomeTask } = await import("../apps/client/ui/client-home-model.ts");

const activeMembership = {
  id: "membership-1",
  planCode: "monthly_v1",
  status: "ACTIVE",
  startsAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-09-01T00:00:00.000Z",
  closeOnly: false,
};

test("home sends a legally confirmed new customer to membership instead of looping back to consent", () => {
  assert.deepEqual(deriveClientHomeTask({
    canViewMembership: true,
    membership: null,
    latestOrder: null,
    canViewPaper: true,
    portfolios: [],
  }), {
    title: "选择会员计划",
    description: "当前法务版本已确认，但没有有效会员或待处理申请。可在会员中心选择计划并提交人工付款申请。",
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
