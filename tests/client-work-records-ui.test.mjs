import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  strategyWorkRecordAdmissionPresentation,
  strategyWorkRecordCompletenessLabel,
  strategyWorkRecordDecisionLabel,
  strategyWorkRecordEvidenceRows,
  strategyWorkRecordExecutionModeLabel,
} from "../apps/client/ui/work-record-presentation.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("work record presentation makes status and evidence understandable without exposing raw objects", () => {
  assert.equal(strategyWorkRecordDecisionLabel("enter_long"), "计划开多");
  assert.equal(strategyWorkRecordDecisionLabel("hold"), "本轮观望");
  assert.equal(strategyWorkRecordDecisionLabel("unexpected_state"), "待确认（unexpected_state）");
  assert.equal(strategyWorkRecordExecutionModeLabel("paper"), "Paper 模拟盘");
  assert.equal(strategyWorkRecordExecutionModeLabel("shadow"), "影子模拟盘");
  assert.equal(strategyWorkRecordCompletenessLabel("complete"), "七阶段完整");
  assert.equal(strategyWorkRecordCompletenessLabel("legacy"), "历史兼容记录");
  assert.deepEqual(strategyWorkRecordAdmissionPresentation("not_required"), {
    label: "本轮无需组合准入",
    detail: "公共结论为观望，按规则不为每个组合重复写入准入记录。",
  });
  assert.deepEqual(strategyWorkRecordAdmissionPresentation("not_recorded"), {
    label: "组合准入未记录",
    detail: "本轮不是纯观望，但服务端没有该组合的准入记录；不会推断为已放行或已执行。",
  });

  assert.deepEqual(strategyWorkRecordEvidenceRows({
    valid: true,
    riskState: { drawdownPct: 3.25, halted: false },
    rejectionReasons: ["超过仓位上限", "行情陈旧"],
    orderIntent: null,
  }), [
    { label: "数据有效", value: "是" },
    { label: "风险状态 · 回撤", value: "3.25" },
    { label: "风险状态 · 已熔断", value: "否" },
    { label: "拒绝原因", value: "超过仓位上限；行情陈旧" },
    { label: "模拟意图", value: "未记录" },
  ]);
});

test("Client work record workspace exposes list, detail, pagination and the product safety boundary", async () => {
  const [workspace, detail, portal, navigation, routeContract] = await Promise.all([
    read("apps/client/ui/work-records-workspace.tsx"),
    read("apps/client/ui/work-record-detail.tsx"),
    read("apps/client/ui/client-portal.tsx"),
    read("apps/client/ui/client-information-architecture.ts"),
    read("app/riverton-route-contract.ts"),
  ]);
  const workRecordUi = `${workspace}\n${detail}`;

  assert.match(workRecordUi, /\/api\/work-records\?limit=20/);
  assert.match(workRecordUi, /\/api\/work-records\/\$\{encodeURIComponent\(recordId\)\}/);
  assert.match(workRecordUi, /LoadingState/);
  assert.match(workRecordUi, /ErrorState/);
  assert.match(workRecordUi, /EmptyState/);
  assert.match(workRecordUi, /加载更多/);
  assert.match(workRecordUi, /公共决策/);
  assert.match(workRecordUi, /行情摘要/);
  assert.match(workRecordUi, /七阶段/);
  assert.match(workRecordUi, /你的组合准入/);
  assert.match(workRecordUi, /模拟意图与成交/);
  assert.match(workRecordUi, /审计边界/);
  assert.match(workRecordUi, /真实订单路由保持关闭/);
  assert.match(workRecordUi, /tabIndex=\{0\}/);
  assert.match(workRecordUi, /aria-label=\{t\("七阶段工作记录"\)\}/);
  assert.doesNotMatch(workRecordUi, /JSON\.stringify/);

  assert.match(portal, /WorkRecordsWorkspace/);
  assert.match(portal, /\["trading", "trading-hall", "paper", "work-records"\][\s\S]{0,320}client\.paper\.view/);
  assert.match(portal, /href: "\/trading\?tab=records"/);
  assert.match(navigation, /href: "\/trading"/);
  assert.match(routeContract, /root === "work-records"[\s\S]*segments\.length <= 2/);
});
