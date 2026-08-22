import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Operations Credits UI exposes maker-checker controls without claiming submission changed balance", async () => {
  const ui = await readFile(new URL("../apps/operations/ui/credits-workspace.tsx", import.meta.url), "utf8");
  const app = await Promise.all([readFile(new URL("../apps/operations/ui/operations-app.tsx", import.meta.url), "utf8"), readFile(new URL("../apps/operations/ui/navigation.ts", import.meta.url), "utf8")]).then((parts) => parts.join("\n"));
  const submit = await readFile(new URL("../app/api/operations/credit-adjustments/route.ts", import.meta.url), "utf8");
  const decision = await readFile(new URL("../app/api/operations/credit-adjustments/[id]/decision/route.ts", import.meta.url), "utf8");
  assert.match(app, /ops\.credits\.adjust/);
  assert.match(app, /ops\.credits\.approve/);
  assert.match(ui, /余额不会立即改变/);
  assert.match(ui, /禁止自审/);
  assert.match(ui, /idempotency-key/);
  assert.match(submit, /ops\.credits\.adjust/);
  assert.match(decision, /ops\.credits\.approve/);
});
