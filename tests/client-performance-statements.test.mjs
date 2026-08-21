import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { performanceStatementTimeline } from "../lib/commercial-public-contract.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("client statement timeline exposes only deterministic customer-visible events", () => {
  const timeline = performanceStatementTimeline({
    statement: {
      id: "statement-1",
      status: "paid",
      created_at: "2026-08-10T00:00:00.000Z",
    },
    decisions: [
      {
        id: "decision-payment",
        stage: "payment",
        decision: "approve",
        created_at: "2026-08-12T00:00:00.000Z",
        reviewer_user_id: "internal-checker",
      },
      {
        id: "decision-assessment",
        stage: "assessment",
        decision: "approve",
        created_at: "2026-08-11T00:00:00.000Z",
        reviewer_user_id: "internal-checker",
      },
    ],
    evidence: [{
      id: "evidence-1",
      status: "accepted",
      created_at: "2026-08-11T12:00:00.000Z",
      reviewed_at: "2026-08-12T00:00:00.000Z",
      reference_masked: "***1234",
      recorded_by_user_id: "internal-maker",
    }],
    receivable: {
      id: "receivable-1",
      created_at: "2026-08-11T00:00:00.000Z",
      paid_at: "2026-08-12T00:00:00.000Z",
    },
  });

  assert.deepEqual(timeline.map((event) => event.kind), [
    "STATEMENT_CREATED",
    "ASSESSMENT_APPROVED",
    "RECEIVABLE_CREATED",
    "PAYMENT_EVIDENCE_RECORDED",
    "PAYMENT_EVIDENCE_ACCEPTED",
    "PAYMENT_APPROVED",
    "STATEMENT_PAID",
  ]);
  assert.deepEqual(Object.keys(timeline[0]).sort(), ["id", "kind", "occurredAt"]);
  assert.equal(JSON.stringify(timeline).includes("internal-checker"), false);
  assert.equal(JSON.stringify(timeline).includes("***1234"), false);
});

test("client performance statement detail is ownership scoped and privacy projected", async () => {
  const route = await read("app/api/membership/performance-statements/[id]/route.ts");
  assert.match(route, /requireAccessPermission\([\s\S]*client\.membership\.view/);
  assert.match(route, /s\.id=\$1\s+AND\s+s\.user_id=\$2/);
  assert.match(route, /performanceStatementTimeline/);
  assert.match(route, /performanceStatementDto/);
  assert.doesNotMatch(route, /reviewerUserId|recordedByUserId|referenceMasked/);
  assert.match(route, /cache-control["']:\s*["']no-store/);
});

test("client statement workspace provides list, detail, timeline and honest payment boundaries", async () => {
  const workspace = await read("apps/client/ui/performance-statements-workspace.tsx");
  const portal = await read("apps/client/ui/client-portal.tsx");
  const shell = await read("apps/client/ui/client-portal-shell.tsx");
  assert.match(workspace, /\/api\/membership\/performance-statements\?limit=/);
  assert.match(workspace, /\/api\/membership\/performance-statements\/\$\{/);
  assert.match(workspace, /performanceStatementTimelineLabels/);
  assert.match(workspace, /LoadingState/);
  assert.match(workspace, /ErrorState/);
  assert.match(workspace, /EmptyState/);
  assert.match(workspace, /不会自动扣款/);
  assert.match(workspace, /当前已提交高水位/);
  assert.match(workspace, /付款复核通过后预计高水位/);
  assert.match(workspace, /预计高水位尚未提交/);
  assert.doesNotMatch(workspace, /<dt>结算后高水位<\/dt>/);
  assert.match(portal, /PerformanceStatementsWorkspace/);
  assert.match(shell, /href:\s*"\/performance-statements"/);
});

test("client home loads the latest statement and unread count as independent summaries", async () => {
  const home = await read("apps/client/ui/client-home-workspace.tsx");
  const inbox = await read("app/api/notifications/inbox/route.ts");
  assert.match(home, /\/api\/membership\/performance-statements\?limit=1/);
  assert.match(home, /\/api\/notifications\/inbox\?summary=1/);
  assert.match(home, /label="最新绩效账单"/);
  assert.match(home, /label="未读通知"/);
  assert.match(inbox, /summary/);
  assert.match(inbox, /isNull\(notificationDeliveries\.readAt\)/);
});
