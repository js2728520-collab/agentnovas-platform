import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";
import pg from "pg";

import { totpCode } from "../../lib/mfa.ts";
import { createIsolatedQualityBrowser, expect } from "../../tests/e2e/support/quality-test.ts";
import {
  cleanupQualityDatabaseFixture,
  prepareQualityDatabaseFixture,
} from "./quality-database-fixture.mjs";
import {
  createQualityRunEnvironment,
  finalizeQualityFixtureCleanup,
  prepareQualityStandaloneAssets,
  resetQualityE2eOutput,
} from "./quality-e2e-runner.mjs";
import {
  assertQualitySideEffectsDisabled,
  qualityApplicationPorts,
  qualitySchemaName,
  redactPotentialSecrets,
} from "./quality-policy.mjs";

const audiences = ["client", "operations", "maintenance"];
const identityNames = {
  client: "clientSecurity",
  operations: "operationsMaker",
  maintenance: "maintenanceAdmin",
};
const landingPaths = { client: "/dashboard", operations: "/", maintenance: "/" };
const landingHeadings = { client: /欢迎回来$/, operations: "运营概览", maintenance: "系统概览" };

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function currentTotp(secret, offset = 0) {
  return totpCode(secret, Math.floor(Date.now() / 30_000) + offset);
}

async function login(isolated, identity) {
  await isolated.page.goto("/login", { waitUntil: "networkidle" });
  await isolated.page.getByLabel("邮箱、手机号或用户名").fill(identity.email);
  await isolated.page.getByLabel("密码").fill(identity.password);
  await isolated.page.getByRole("button", { name: "登录", exact: true }).click();
}

async function expectCurrentUser(isolated, userId) {
  const result = await isolated.page.evaluate(async () => {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(result).toMatchObject({ status: 200, body: { user: { id: userId } } });
}

async function completeInternalEnrollment(isolated) {
  await expect(isolated.page.getByRole("heading", { name: "绑定双重验证" })).toBeVisible();
  const secret = await isolated.page.getByLabel("身份验证器设置密钥").inputValue();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await isolated.page.getByLabel("六位动态验证码").fill(await currentTotp(secret));
  await isolated.page.getByRole("button", { name: "绑定并生成恢复码" }).click();
  await expect(isolated.page.getByRole("heading", { name: "保存恢复码" })).toBeVisible();
  await expect(isolated.page.locator(".rc-recovery-codes code")).toHaveCount(8);
  await isolated.page.getByRole("button", { name: "我已安全保存，进入应用" }).click();
  return secret;
}

async function enrollAudience(browser, audience, identity) {
  const isolated = await createIsolatedQualityBrowser(browser, audience);
  try {
    await login(isolated, identity);
    let secret;
    if (audience === "client") {
      await expect(isolated.page).toHaveURL(`${isolated.origin}/dashboard`);
      await isolated.page.goto("/account/security", { waitUntil: "networkidle" });
      await isolated.page.getByRole("button", { name: "绑定身份验证器" }).click();
      secret = await isolated.page.getByLabel("身份验证器设置密钥").inputValue();
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      await isolated.page.getByLabel("六位动态验证码").fill(await currentTotp(secret));
      await isolated.page.getByRole("button", { name: "确认绑定并生成恢复码" }).click();
      await expect(isolated.page.locator(".rc-recovery-codes code")).toHaveCount(8);
      await isolated.page.getByRole("button", { name: "我已安全保存，从页面清除" }).click();
    } else {
      secret = await completeInternalEnrollment(isolated);
      await expect(isolated.page).toHaveURL(`${isolated.origin}${landingPaths[audience]}`);
    }
    await expectCurrentUser(isolated, identity.userId);
    return secret;
  } finally {
    await isolated.close();
  }
}

async function loginWithEnforcementOff(browser, audience, identity) {
  const isolated = await createIsolatedQualityBrowser(browser, audience);
  try {
    await login(isolated, identity);
    await expect(isolated.page).toHaveURL(`${isolated.origin}${landingPaths[audience]}`);
    await isolated.page.waitForLoadState("networkidle");
    await expect(isolated.page.getByRole("heading", { name: landingHeadings[audience] })).toBeVisible();
    await expect(isolated.page.getByRole("heading", { name: "双重验证", exact: true })).toHaveCount(0);
    await expectCurrentUser(isolated, identity.userId);
    return await isolated.page.context().cookies();
  } finally {
    await isolated.close();
  }
}

async function proveOffSessionCannotBypassReenabledMfa(browser, audience, identity, cookies) {
  const isolated = await createIsolatedQualityBrowser(browser, audience);
  try {
    await isolated.page.context().addCookies(cookies);
    await isolated.page.goto("/api/auth/me", { waitUntil: "domcontentloaded" });
    expect(JSON.parse(await isolated.page.locator("body").innerText())).toMatchObject({ user: null });
  } finally {
    await isolated.close();
  }
}

async function loginAfterReenable(browser, audience, identity, secret) {
  const isolated = await createIsolatedQualityBrowser(browser, audience);
  try {
    await login(isolated, identity);
    await expect(isolated.page.getByRole("heading", { name: "双重验证", exact: true })).toBeVisible();
    await isolated.page.getByLabel("动态验证码或恢复码").fill(await currentTotp(secret, 1));
    await isolated.page.getByRole("button", { name: "验证并进入" }).click();
    await expect(isolated.page).toHaveURL(`${isolated.origin}${landingPaths[audience]}`);
    await isolated.page.waitForLoadState("networkidle");
    await expectCurrentUser(isolated, identity.userId);
  } finally {
    await isolated.close();
  }
}

async function waitForServer(port, audience, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${audience} server exited before readiness`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
        headers: {
          host: `${audience === "client" ? "agentnovas.com" : audience === "operations" ? "zht.agentnovas.com" : "xm.agentnovas.com"}:${port}`,
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
        },
      });
      await response.body?.cancel();
      return;
    } catch {
      // The socket is expected to refuse connections while standalone starts.
    }
    await delay(250);
  }
  throw new Error(`${audience} server did not become ready`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function startServers(repositoryRoot, environment, enabled) {
  const ports = qualityApplicationPorts(environment);
  const children = [];
  try {
    for (const audience of audiences) {
      const child = spawn(process.execPath, [join(repositoryRoot, `.next-${audience}`, "standalone", "server.js")], {
        cwd: repositoryRoot,
        env: {
          ...environment,
          RIVERTON_APP_AUDIENCE: audience,
          MFA_ENFORCEMENT_ENABLED: enabled ? "true" : "false",
          HOSTNAME: "127.0.0.1",
          PORT: String(ports[audience]),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnostics = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          diagnostics = redactPotentialSecrets(`${diagnostics}${chunk}`).slice(-4_000);
        });
      }
      child.rolloutDiagnostics = () => diagnostics;
      children.push({ audience, child });
    }
    await Promise.all(children.map(({ audience, child }) => waitForServer(ports[audience], audience, child)));
    return async () => Promise.all(children.map(({ child }) => stopChild(child)));
  } catch (error) {
    await Promise.all(children.map(({ child }) => stopChild(child)));
    const diagnostics = children.map(({ audience, child }) => `${audience}: ${child.rolloutDiagnostics()}`).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
  }
}

async function main() {
  const repositoryRoot = process.cwd();
  const portOffset = process.env.QUALITY_E2E_PORT_OFFSET || "610";
  const outputDirectory = resolve(repositoryRoot, process.env.QUALITY_E2E_OUTPUT_DIR || "outputs/quality-mfa-rollout");
  const runtimeDirectory = join(outputDirectory, ".runtime");
  const schema = qualitySchemaName(`mfa_rollout_${Date.now()}_${process.pid}_${randomBytes(3).toString("hex")}`);
  const adminDatabaseUrl = process.env.QUALITY_E2E_DATABASE_URL || process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
  const startedAt = new Date();
  const baseEnvironment = { ...process.env, QUALITY_E2E_PORT_OFFSET: portOffset };
  const ports = qualityApplicationPorts(baseEnvironment);
  const environment = createQualityRunEnvironment({
    baseEnvironment,
    applicationDatabaseUrl: "pending",
    outputDirectory,
    profile: "mfa-on",
    runtimeDirectory,
    schema,
  });
  assertQualitySideEffectsDisabled(environment);
  await resetQualityE2eOutput({ repositoryRoot, outputDirectory });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await prepareQualityStandaloneAssets(repositoryRoot);

  let fixture;
  let browser;
  let stopServers = async () => {};
  let passed = false;
  let primaryError;
  try {
    fixture = await prepareQualityDatabaseFixture({
      adminDatabaseUrl,
      schema,
      outputDirectory: runtimeDirectory,
      baseUrls: Object.fromEntries(audiences.map((audience) => [audience, `http://127.0.0.1:${ports[audience]}`])),
    });
    Object.assign(environment, {
      DATABASE_URL: fixture.applicationDatabaseUrl,
      TEST_DATABASE_URL: fixture.applicationDatabaseUrl,
      RESEARCH_DATABASE_URL: fixture.applicationDatabaseUrl,
    });
    browser = await chromium.launch({
      proxy: {
        server: "http://127.0.0.1:9",
        bypass: "agentnovas.com,zht.agentnovas.com,xm.agentnovas.com,127.0.0.1,localhost",
      },
    });

    stopServers = await startServers(repositoryRoot, environment, true);
    const secrets = {};
    for (const audience of audiences) {
      secrets[audience] = await enrollAudience(browser, audience, fixture.identities[identityNames[audience]]);
    }
    await stopServers();
    stopServers = async () => {};

    stopServers = await startServers(repositoryRoot, environment, false);
    const offCookies = {};
    for (const audience of audiences) {
      offCookies[audience] = await loginWithEnforcementOff(browser, audience, fixture.identities[identityNames[audience]]);
    }
    await stopServers();
    stopServers = async () => {};

    stopServers = await startServers(repositoryRoot, environment, true);
    for (const audience of audiences) {
      const identity = fixture.identities[identityNames[audience]];
      await proveOffSessionCannotBypassReenabledMfa(browser, audience, identity, offCookies[audience]);
      await loginAfterReenable(browser, audience, identity, secrets[audience]);
    }

    const pool = new pg.Pool({ connectionString: fixture.applicationDatabaseUrl, max: 1 });
    try {
      const evidence = await pool.query(`
        SELECT count(*)::int AS credential_count,
               count(*) FILTER (WHERE credential.status='active')::int AS active_count
          FROM user_mfa_totp_credentials AS credential
         WHERE credential.user_id=ANY($1::text[])
      `, [audiences.map((audience) => fixture.identities[identityNames[audience]].userId)]);
      expect(evidence.rows[0]).toMatchObject({ credential_count: 3, active_count: 3 });
    } finally {
      await pool.end();
    }

    await writeFile(join(outputDirectory, "phase-evidence.json"), JSON.stringify({
      phases: ["enabled_enrollment", "disabled_direct_login", "reenabled_challenge"],
      audiences,
      offSessionsRejectedAfterReenable: true,
      activeCredentialsPreserved: 3,
      externalWritesEnabled: false,
    }, null, 2));
    passed = true;
  } catch (error) {
    primaryError = error;
  } finally {
    await stopServers().catch((error) => { primaryError ??= error; });
    await browser?.close().catch((error) => { primaryError ??= error; });
    await finalizeQualityFixtureCleanup({
      outputDirectory,
      runtimeDirectory,
      schema,
      startedAt,
      fixturePrepared: Boolean(fixture),
      gateResult: {
        passed,
        expectedJourneys: 9,
        phases: 3,
        externalWritesEnabled: false,
        profile: "mfa-rollout",
      },
      cleanupSchema: () => cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema }),
    }).catch((error) => { primaryError ??= error; });
  }
  if (primaryError) throw primaryError;
}

main().catch((error) => {
  process.stderr.write(`${redactPotentialSecrets(error instanceof Error ? error.stack || error.message : String(error))}\n`);
  process.exitCode = 1;
});
