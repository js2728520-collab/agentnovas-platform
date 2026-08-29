import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Maintenance exposes a permission guarded stable technical audit page", async () => {
  const routeContract = await readFile(new URL("../app/riverton-route-contract.ts", import.meta.url), "utf8");
  const app = await Promise.all([readFile(new URL("../apps/maintenance/ui/maintenance-app.tsx", import.meta.url), "utf8"), readFile(new URL("../apps/maintenance/ui/maintenance-information-architecture.ts", import.meta.url), "utf8")]).then((parts) => parts.join("\n"));
  const api = await readFile(new URL("../app/api/maintenance/audit/route.maintenance.ts", import.meta.url), "utf8");
  const query = await readFile(new URL("../lib/maintenance-technical-audit.ts", import.meta.url), "utf8");
  assert.match(routeContract, /MAINTENANCE_ROUTES[^\n]+"audit"/);
  assert.match(app, /href: "\/releases\?tab=technical-audit"[^\n]+maint\.audit\.view/);
  assert.match(app, /tab === "technical-audit" \? <TechnicalAuditWorkspace/);
  assert.match(app, /legacyRoot === "audit"/);
  assert.match(api, /requireAccessPermission\(request, "maint\.audit\.view"\)/);
  assert.match(query, /audit\.action LIKE 'maintenance\.%'/);
  assert.match(query, /audit\.action LIKE 'auth\.mfa_%'/);
  assert.match(query, /event\.request_id/);
  assert.match(query, /event\.trace_id/);
  assert.match(query, /audit\.after_json::jsonb->>'status'='failed'/);
  assert.match(query, /audit\.error_code IS NOT NULL/);
  assert.doesNotMatch(query, /response_json|idempotency_key|canonical_payload_sha256|provider_order|client_order/i);
  const workspace = await readFile(new URL("../apps/maintenance/ui/technical-audit-workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /window\.location\.search/);
  assert.match(workspace, /window\.location\.pathname/);
  assert.doesNotMatch(workspace, /replaceState\(null, "", `\/audit/);
});
