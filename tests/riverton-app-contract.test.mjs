import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  APP_DEFINITIONS,
  cookieNameForAudience,
  resolveAppAudience,
} from "../lib/riverton-apps.ts";

test("defines three independently deployed application audiences", async () => {
  assert.deepEqual(APP_DEFINITIONS.map((app) => app.id), ["client", "operations", "maintenance"]);
  assert.equal(APP_DEFINITIONS.find((app) => app.id === "client")?.domain, "agentnovas.com");
  assert.equal(APP_DEFINITIONS.find((app) => app.id === "operations")?.domain, "zht.agentnovas.com");
  assert.equal(APP_DEFINITIONS.find((app) => app.id === "maintenance")?.domain, "xm.agentnovas.com");
  assert.equal(cookieNameForAudience("client"), "rc_client_session");
  assert.equal(cookieNameForAudience("operations"), "rc_ops_session");
  assert.equal(cookieNameForAudience("maintenance"), "rc_maint_session");
  assert.equal(resolveAppAudience({ host: "zht.agentnovas.com" }), "operations");
  assert.equal(resolveAppAudience({ host: "xm.agentnovas.com" }), "maintenance");
  assert.equal(resolveAppAudience({ host: "agentnovas.com" }), "client");

  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts["dev:client"], /RIVERTON_APP_AUDIENCE=client/);
  assert.match(packageJson.scripts["dev:operations"], /RIVERTON_APP_AUDIENCE=operations/);
  assert.match(packageJson.scripts["dev:maintenance"], /RIVERTON_APP_AUDIENCE=maintenance/);
  assert.match(packageJson.scripts["worker:payment"], /scripts\/payment-worker\.mjs/);
  assert.match(packageJson.scripts["worker:notification"], /scripts\/notification-worker\.mjs/);
});

test("login route validates application access before issuing an app session", async () => {
  const source = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  assert.match(source, /userCanAccessApp/);
  assert.match(source, /无权登录当前应用/);
  assert.match(source, /application_id = \$2/);
});
