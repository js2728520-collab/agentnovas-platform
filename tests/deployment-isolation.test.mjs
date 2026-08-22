import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("production units use per-process environment files and unique web ports", async () => {
  const units = {
    client: await read("deploy/systemd/riverton-client.service"),
    operations: await read("deploy/systemd/riverton-operations.service"),
    maintenance: await read("deploy/systemd/riverton-maintenance.service"),
    notification: await read("deploy/systemd/riverton-notification-worker.service"),
    demo: await read("deploy/systemd/riverton-demo-execution-worker.service"),
    research: await read("deploy/systemd/agentnovas-research-worker.service"),
    runtime: await read("deploy/systemd/agentnovas-runtime-worker.service"),
  };
  for (const [name, source] of Object.entries(units)) {
    assert.match(source, new RegExp(`EnvironmentFile=/etc/agentnovas/${name}\\.env`));
    assert.doesNotMatch(source, /EnvironmentFile=.*agentnovas\.env$/m);
  }
  assert.match(units.client, /Environment=PORT=3000/);
  assert.match(units.operations, /Environment=PORT=3001/);
  assert.match(units.maintenance, /Environment=PORT=3002/);
  assert.match(units.demo, /npm run worker:demo/);
  assert.match(units.research, /^RefuseManualStart=yes$/m);
  assert.match(units.research, /^Restart=no$/m);
  assert.doesNotMatch(units.research, /^WantedBy=/m);
});

test("commercial Beta deploy surface contains no legacy web or payment worker unit", async () => {
  const names = await readdir(new URL("deploy/systemd/", root));
  assert.equal(names.includes("agentnovas-web.service"), false);
  assert.equal(names.includes("riverton-payment-worker.service"), false);
  await assert.rejects(access(new URL("deploy/nginx/agentnovas.com.conf", root)));
});

test("environment examples preserve disabled external effects", async () => {
  const demo = await read("deploy/env/demo.env.example");
  const notification = await read("deploy/env/notification.env.example");
  const maintenance = await read("deploy/env/maintenance.env.example");
  const client = await read("deploy/env/client.env.example");
  const legacy = await read("deploy/agentnovas.env.example");
  assert.match(demo, /^DEMO_EXECUTION_WORKER_ENABLED=false$/m);
  assert.match(demo, /^PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false$/m);
  assert.match(maintenance, /^DEMO_EXECUTION_WORKER_ENABLED=false$/m);
  assert.match(maintenance, /^PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false$/m);
  assert.doesNotMatch(demo, /PAYMENT_WORKER_ENABLED=true/);
  assert.match(notification, /^NOTIFICATION_EMAIL_SEND_ENABLED=false$/m);
  assert.match(notification, /^RESEND_API_KEY=$/m);
  assert.match(notification, /^NOTIFICATION_EMAIL_ALLOWLIST=$/m);
  assert.match(notification, /^NOTIFICATION_TOKEN_ENCRYPTION_KEY=/m);
  assert.doesNotMatch(notification, /^RESEND_WEBHOOK_SECRET=/m);
  assert.match(client, /^NOTIFICATION_TOKEN_ENCRYPTION_KEY=/m);
  assert.match(maintenance, /^RESEND_WEBHOOK_SECRET=$/m);
  assert.doesNotMatch(maintenance, /^RESEND_API_KEY=/m);
  assert.doesNotMatch(client, /EXCHANGE_CREDENTIAL_ENCRYPTION_KEY/);
  assert.match(legacy, /RETIRED|DO NOT USE/i);
  assert.doesNotMatch(legacy, /^(?:DATABASE_URL|.*(?:SECRET|KEY|PASSWORD))=/m);
});

test("reverse proxy contains no legacy research fast path", async () => {
  const nginx = await read("deploy/nginx/riverton-three-apps.conf");
  assert.doesNotMatch(nginx, /api\/strategy-research|proxy_read_timeout\s+3600s/);
});

test("reverse proxy hard-closes payment webhooks before the application", async () => {
  const nginx = await read("deploy/nginx/riverton-three-apps.conf");
  assert.match(nginx, /location ~ \^\/api\/integrations\/payments\/.+?\{\s*return 404;\s*\}/s);
  const paymentLocation = nginx.match(/location ~ \^\/api\/integrations\/payments\/.+?\n\s*\}/s)?.[0] ?? "";
  assert.doesNotMatch(paymentLocation, /proxy_pass/);
});
