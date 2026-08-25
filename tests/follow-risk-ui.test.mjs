import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("三处注册齐全：白名单、分发、导航", async () => {
  const [contract, app, navigation] = await Promise.all([
    read("app/riverton-route-contract.ts"),
    read("apps/operations/ui/operations-app.tsx"),
    read("apps/operations/ui/navigation.ts"),
  ]);
  assert.match(contract, /"follow-risk"/);
  assert.match(app, /route === "follow-risk"/);
  assert.match(navigation, /href: "\/follow-risk"/);
  // 懒加载：与其它运营工作区一致。
  assert.match(app, /const FollowRiskWorkspace = dynamic\(/);
});

test("「谁停的」是独立一列，不与状态合并", async () => {
  const workspace = await read("apps/operations/ui/follow-risk-workspace.tsx");
  // 谁停的决定谁能恢复（PRD 6.6）。合进状态列，运营就看不出这个阻断自己能不能解。
  assert.match(workspace, /<th>谁停的<\/th>/);
  assert.match(workspace, /authorityLabels/);
  for (const authority of ["customer", "operations_risk", "automated_risk", "global_circuit_breaker"]) {
    assert.ok(workspace.includes(authority), `缺少权威 ${authority} 的展示`);
  }
});

test("空的「谁停的」表示没被停，不是不知道", async () => {
  const workspace = await read("apps/operations/ui/follow-risk-workspace.tsx");
  assert.match(workspace, /空着说明它没被停，不是「不知道谁停的」/);
});

test("被阻断的排最前", async () => {
  // 那是运营真正要处理的；按 id 排会让它们埋在几百行里。
  const route = await read("app/api/operations/follow-risk/route.operations.ts");
  assert.match(route, /CASE subscription\.status WHEN 'risk_blocked' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END/);
});

test("每次操作都要填原因", async () => {
  const workspace = await read("apps/operations/ui/follow-risk-workspace.tsx");
  // 一个没有理由的阻断，事后没人知道能不能摘。
  assert.match(workspace, /hasValidAuditReason\(reason\)/);
  assert.match(workspace, /一个没有理由的阻断，事后没人知道能不能摘/);
  const route = await read("app/api/operations/follow-risk/[id]/decision/route.operations.ts");
  assert.match(route, /FOLLOW_RISK_REASON_INVALID/);
});

test("界面说清解除阻断的不对称与权威限制", async () => {
  const workspace = await read("apps/operations/ui/follow-risk-workspace.tsx");
  assert.match(workspace, /解除阻断不能由当初阻断的人自己完成/);
  assert.match(workspace, /系统自动风控与全局熔断造成的阻断，运营风控无法解除/);
});

test("总览不返回策略规格与客户身份", async () => {
  const route = await read("app/api/operations/follow-risk/route.operations.ts");
  // 审核一个跟单该不该被阻断，不需要知道客户是谁、也不需要看策略代码。
  assert.doesNotMatch(route, /specification_json/);
  assert.doesNotMatch(route, /customer_id|users\./);
  assert.match(route, /不返回策略规格与客户联系方式/);
});

test("策略已下架而跟随还在，界面要一眼看到", async () => {
  const workspace = await read("apps/operations/ui/follow-risk-workspace.tsx");
  assert.match(workspace, /follow\.listingStatus === "delisted"/);
  assert.match(workspace, /策略已下架/);
});
