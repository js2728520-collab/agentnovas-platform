import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Maintenance exposes a permission-gated maker-checker commercial disclosure workspace", async () => {
  const app = await Promise.all([read("apps/maintenance/ui/maintenance-app.tsx"), read("apps/maintenance/ui/maintenance-information-architecture.ts")]).then((parts) => parts.join("\n"));
  const workspace = await read("apps/maintenance/ui/commercial-disclosures-workspace.tsx");
  assert.match(app, /\/configurations\?tab=disclosures/);
  assert.match(app, /legacyRoot === "settings"/);
  assert.match(app, /maint\.commercial_disclosures\.view/);
  assert.match(app, /maint\.commercial_disclosures\.submit/);
  assert.match(app, /maint\.commercial_disclosures\.approve/);
  assert.match(workspace, /\/api\/maintenance\/commercial-disclosures/);
  assert.match(workspace, /idempotency-key/);
  assert.match(workspace, /SELF_APPROVAL|提交人不能|不能复核/);
  assert.match(workspace, /平台商业披露/);
  assert.doesNotMatch(workspace, /已获得法律意见|合规已通过|自动发布/);
});

test("platform settings require explicit service identity instead of inventing an operator", async () => {
  const contract = await read("lib/platform-settings-contract.ts");
  const workspace = await read("apps/maintenance/ui/platform-settings-workspace.tsx");
  for (const key of ["serviceOperatorName", "serviceRegion", "supportEmail", "primaryDomain"]) {
    assert.match(contract, new RegExp(key));
    assert.match(workspace, new RegExp(key));
  }
  assert.match(contract, /serviceOperatorName:\s*""/);
  assert.match(contract, /serviceRegion:\s*""/);
});

test("Client presents versioned commercial disclosures without claiming external legal approval", async () => {
  const experience = await read("apps/client/ui/legal-consent-experience.tsx");
  const membership = await read("apps/client/ui/membership-experience.tsx");
  const gate = `${await read("lib/commercial-legal-consent-gate.ts")}\n${await read("lib/commercial-membership-service.ts")}`;
  assert.match(experience, /商业披露与版本确认/);
  assert.match(experience, /模拟收益服务费说明/);
  assert.doesNotMatch(`${experience}\n${membership}`, /法务|法律意见/);
  assert.doesNotMatch(gate, /当前法务文件|法务文件版本/);
});
