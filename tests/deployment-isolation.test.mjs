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
    "configuration-activation": await read("deploy/systemd/riverton-configuration-activation-worker.service"),
    "release-orchestrator": await read("deploy/systemd/agentnovas-release-orchestrator@.service"),
    "release-webhook": await read("deploy/systemd/agentnovas-release-webhook-ingress.service"),
    demo: await read("deploy/systemd/riverton-demo-execution-worker.service"),
    research: await read("deploy/systemd/agentnovas-research-worker.service"),
    runtime: await read("deploy/systemd/agentnovas-runtime-worker.service"),
  };
  for (const [name, source] of Object.entries(units)) {
    const environmentFile = name === "release-orchestrator"
      ? "release-orchestrator-%i.env"
      : `${name}.env`;
    assert.match(source, new RegExp(`EnvironmentFile=/etc/agentnovas/${environmentFile.replace(".", "\\.")}`));
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
  assert.equal(names.includes("agentnovas-release-control.service"), false);
  assert.equal(names.includes("agentnovas-release-identity-verifier.service"), false);
  await assert.rejects(access(new URL("deploy/nginx/agentnovas.com.conf", root)));
});

test("environment examples preserve disabled external effects", async () => {
  const demo = await read("deploy/env/demo.env.example");
  const notification = await read("deploy/env/notification.env.example");
  const maintenance = await read("deploy/env/maintenance.env.example");
  const configurationActivation = await read("deploy/env/configuration-activation.env.example");
  const releaseOrchestrator = await read("deploy/env/release-orchestrator.env.example");
  const releaseWebhook = await read("deploy/env/release-webhook.env.example");
  const releaseControl = await read("deploy/env/release-control.env.example");
  const releaseIdentityVerifier = await read("deploy/env/release-identity-verifier.env.example");
  const client = await read("deploy/env/client.env.example");
  const legacy = await read("deploy/agentnovas.env.example");
  assert.match(demo, /^DEMO_EXECUTION_WORKER_ENABLED=false$/m);
  assert.match(demo, /^PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false$/m);
  assert.match(maintenance, /^DEMO_EXECUTION_WORKER_ENABLED=false$/m);
  assert.match(maintenance, /^PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false$/m);
  assert.match(maintenance, /^CONFIGURATION_ACTIVATION_WORKER_ENABLED=false$/m);
  assert.match(configurationActivation, /^CONFIGURATION_ACTIVATION_WORKER_ENABLED=false$/m);
  assert.match(releaseOrchestrator, /^RELEASE_ORCHESTRATOR_WORKER_ENABLED=false$/m);
  assert.match(releaseWebhook, /^RELEASE_WEBHOOK_INGRESS_ENABLED=false$/m);
  assert.match(releaseWebhook, /^RELEASE_WEBHOOK_DATABASE_URL=postgresql:\/\/agentnovas_release_ingress:/m);
  assert.match(releaseControl, /^RELEASE_CONTROL_ENABLED=false$/m);
  assert.match(releaseIdentityVerifier, /^RELEASE_IDENTITY_VERIFIER_ENABLED=false$/m);
  assert.match(releaseIdentityVerifier, /^RELEASE_IDENTITY_VERIFIER_DATABASE_URL=postgresql:\/\/agentnovas_release_identity_verifier:/m);
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

test("reverse proxy opens the exact Udun callback and hard-closes every other payment webhook", async () => {
  const nginx = await read("deploy/nginx/riverton-three-apps.conf");
  const udunLocation = nginx.match(/location = \/api\/integrations\/payments\/udun\/webhook \{[\s\S]*?\n\s*\}/)?.[0] ?? "";
  assert.match(udunLocation, /limit_except POST/);
  assert.match(udunLocation, /proxy_pass http:\/\/riverton_maintenance/);
  assert.match(udunLocation, /proxy_set_header Host \$host/);
  assert.match(nginx, /location ~ \^\/api\/integrations\/payments\/.+?\{\s*return 404;\s*\}/s);
  const paymentLocation = nginx.match(/location ~ \^\/api\/integrations\/payments\/.+?\n\s*\}/s)?.[0] ?? "";
  assert.doesNotMatch(paymentLocation, /proxy_pass/);
});

test("执行服务在每一份部署产物里都存在", async () => {
  // 它是全系统唯一能解密交易所凭证的进程。代码、测试、架构闸门都齐了，部署侧却
  // 一片空白——compose、systemd、env 模板、配置审计四处全缺。这类缺口没有任何
  // 现成闸门守着：进程不在发布面上，任何代码检查都发现不了。
  const compose = await read("deploy/container/compose.yml");
  assert.match(compose, /^ {2}execution:$/m, "compose 必须有执行服务");
  assert.match(compose, /scripts\/execution-service\.mjs/);

  const unit = await read("deploy/systemd/riverton-execution-service.service");
  assert.match(unit, /EnvironmentFile=\/etc\/agentnovas\/execution\.env/);
  assert.match(unit, /npm run service:execution/);
  // 这个进程持有全部客户凭证的解密能力，内存转储会把明文写到磁盘上。
  assert.match(unit, /^LimitCORE=0$/m);

  const audit = await read("scripts/audit-production-config.sh");
  assert.match(audit, /migrator execution/, "配置审计必须检查第 8 个 env 文件");

  const example = await read("deploy/env/execution.env.example");
  assert.match(example, /^RIVERTON_EXECUTION_SERVICE=true$/m);
  assert.match(example, /^EXECUTION_SERVICE_SHARED_SECRET=/m);
});

test("执行服务不挂 edge 网络", async () => {
  // 它的端口等价于「替任何客户下单」的能力。挂上 edge 就等于把它暴露到反向代理
  // 后面，ADR-0019 第 2 步收敛密钥的意义会被那一行抵消。
  const compose = await read("deploy/container/compose.yml");
  const block = compose.match(/\n {2}execution:\n([\s\S]*?)(?=\n {2}\w+:\n)/)?.[1] ?? "";
  assert.ok(block.length > 0, "找不到 execution 服务定义");
  const networks = block.match(/networks: \[([^\]]+)\]/)?.[1] ?? "";
  assert.ok(!/edge/.test(networks), `execution 不得挂 edge，实际：${networks}`);
  assert.match(networks, /backplane/);
});

test("三个 Web 与 Runtime 都能找到执行服务", async () => {
  // 缺这两行不会报错也不会阻断：客户点验证账户会看到「服务不可用」，
  // 而 Worker 的实盘下发只会被记成一条没人读的 liveExecutionError。
  for (const name of ["client", "operations", "maintenance", "runtime"]) {
    const example = await read(`deploy/env/${name}.env.example`);
    assert.match(example, /^EXECUTION_SERVICE_URL=/m, `${name}.env 缺 EXECUTION_SERVICE_URL`);
    assert.match(example, /^EXECUTION_SERVICE_SHARED_SECRET=/m, `${name}.env 缺共享密钥`);
  }
});
