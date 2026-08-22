import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Operations exposes scoped team brief, targets, follow-ups and masked CSV", async () => {
  const app = await Promise.all([readFile(new URL("../apps/operations/ui/operations-app.tsx", import.meta.url), "utf8"), readFile(new URL("../apps/operations/ui/navigation.ts", import.meta.url), "utf8")]).then((parts) => parts.join("\n"));
  const ui = await readFile(new URL("../apps/operations/ui/team-workspace.tsx", import.meta.url), "utf8");
  const exportRoute = await readFile(new URL("../app/api/team/monthly-targets/export/route.operations.ts", import.meta.url), "utf8");
  const brief = await readFile(new URL("../app/api/team/daily-brief/route.operations.ts", import.meta.url), "utf8");
  const targets = await readFile(new URL("../app/api/team/monthly-targets/route.operations.ts", import.meta.url), "utf8");
  assert.match(app, /\/team/);
  for (const endpoint of ["/api/team/daily-brief", "/api/team/monthly-targets", "/api/team/monthly-targets/follow-up", "/api/team/monthly-targets/export"]) assert.ok(ui.includes(endpoint));
  assert.match(ui, /当前 RBAC 数据范围/);
  assert.match(exportRoute, /ops\.team\.view/);
  assert.match(brief, /official_paper_positions/);
  assert.doesNotMatch(brief, /from\(trades\)/);
  assert.match(targets, /commercial_membership_orders/);
  assert.match(targets, /status='activated'/);
});
