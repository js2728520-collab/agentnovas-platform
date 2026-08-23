import pg from "pg";

import { totpCode } from "../../lib/mfa";
import { createIsolatedQualityBrowser, expect, test } from "./support/quality-test";
import { readQualityRuntime, type QualityIdentity } from "./support/runtime";

type IsolatedBrowser = Awaited<ReturnType<typeof createIsolatedQualityBrowser>>;

async function login(isolated: IsolatedBrowser, identity: QualityIdentity) {
  await isolated.page.goto("/login", { waitUntil: "networkidle" });
  await isolated.page.getByLabel("邮箱、手机号或用户名").fill(identity.email);
  await isolated.page.getByLabel("密码").fill(identity.password);
  await isolated.page.getByRole("button", { name: "登录", exact: true }).click();
}

async function currentTotp(secret: string, offset = 0) {
  return totpCode(secret, Math.floor(Date.now() / 30_000) + offset);
}

async function expectAuthenticatedSession(isolated: IsolatedBrowser, identity: QualityIdentity) {
  const result = await isolated.page.evaluate(async () => {
    const priorSessionRequests = performance.getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path === "/api/auth/me" || path === "/api/access/me/effective");
    const [viewerResponse, accessResponse] = await Promise.all([
      fetch("/api/auth/me", { cache: "no-store" }),
      fetch("/api/access/me/effective", { cache: "no-store" }),
    ]);
    const viewer = await viewerResponse.json().catch(() => ({}));
    const access = await accessResponse.json().catch(() => ({}));
    return { viewerStatus: viewerResponse.status, accessStatus: accessResponse.status, viewer, access, priorSessionRequests };
  });
  expect(result.priorSessionRequests).toEqual(expect.arrayContaining(["/api/auth/me", "/api/access/me/effective"]));
  expect(result.viewerStatus).toBe(200);
  expect(result.accessStatus).toBe(200);
  expect(result.viewer).toMatchObject({ user: { id: identity.userId } });
  expect(result.access).toMatchObject({ appId: identity.audience });
}

async function completeEnrollment(isolated: IsolatedBrowser) {
  await expect(isolated.page.getByRole("heading", { name: "绑定双重验证" })).toBeVisible();
  const secret = await isolated.page.getByLabel("身份验证器设置密钥").inputValue();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await isolated.page.getByLabel("六位动态验证码").fill(await currentTotp(secret));
  await isolated.page.getByRole("button", { name: "绑定并生成恢复码" }).click();
  await expect(isolated.page.getByRole("heading", { name: "保存恢复码" })).toBeVisible();
  const recoveryCodes = await isolated.page.locator(".rc-recovery-codes code").allTextContents();
  expect(recoveryCodes).toHaveLength(8);
  for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{6}$/);
  return { recoveryCodes, secret };
}

async function assertEncryptedCredential(pool: pg.Pool, identity: QualityIdentity) {
  const evidence = await pool.query(`
    SELECT credential.encrypted_secret,credential.status,
           count(recovery.id)::int AS recovery_count,
           count(recovery.id) FILTER (WHERE recovery.used_at IS NOT NULL)::int AS used_count
      FROM user_mfa_totp_credentials AS credential
      LEFT JOIN user_mfa_recovery_codes AS recovery ON recovery.user_id=credential.user_id
     WHERE credential.user_id=$1
     GROUP BY credential.encrypted_secret,credential.status
  `, [identity.userId]);
  expect(evidence.rows[0]).toMatchObject({ status: "active", recovery_count: 8 });
  expect(evidence.rows[0].encrypted_secret).toMatch(/^v1\./);
  return evidence.rows[0] as { used_count: number };
}

test("Client 本地浏览器登录、主动绑定、TOTP 与恢复码再次登录闭环", async ({ browser }) => {
  const runtime = await readQualityRuntime();
  const identity = runtime.identities.clientSecurity;
  const initial = await createIsolatedQualityBrowser(browser, "client");
  const totpLogin = await createIsolatedQualityBrowser(browser, "client");
  const recoveryLogin = await createIsolatedQualityBrowser(browser, "client");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  try {
    await login(initial, identity);
    await expect(initial.page).toHaveURL(`${initial.origin}/dashboard`);
    await initial.page.waitForLoadState("networkidle");
    await initial.page.goto("/account/security", { waitUntil: "networkidle" });
    await expect(initial.page.getByRole("heading", { name: "账号与登录安全" })).toBeVisible();
    await initial.page.getByRole("button", { name: "绑定身份验证器" }).click();
    const secret = await initial.page.getByLabel("身份验证器设置密钥").inputValue();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await initial.page.getByLabel("六位动态验证码").fill(await currentTotp(secret));
    await initial.page.getByRole("button", { name: "确认绑定并生成恢复码" }).click();
    await expect(initial.page.locator(".rc-recovery-codes code")).toHaveCount(8);
    const recoveryCodes = await initial.page.locator(".rc-recovery-codes code").allTextContents();
    expect(recoveryCodes).toHaveLength(8);
    await initial.page.getByRole("button", { name: "我已安全保存，从页面清除" }).click();

    await login(totpLogin, identity);
    await expect(totpLogin.page.getByRole("heading", { name: "双重验证", exact: true })).toBeVisible();
    await totpLogin.page.getByLabel("动态验证码或恢复码").fill(await currentTotp(secret, 1));
    await totpLogin.page.getByRole("button", { name: "验证并进入" }).click();
    await expect(totpLogin.page).toHaveURL(`${totpLogin.origin}/dashboard`);
    await totpLogin.page.waitForLoadState("networkidle");

    await login(recoveryLogin, identity);
    await recoveryLogin.page.getByLabel("动态验证码或恢复码").fill(recoveryCodes[0]);
    await recoveryLogin.page.getByRole("button", { name: "验证并进入" }).click();
    await expect(recoveryLogin.page).toHaveURL(`${recoveryLogin.origin}/dashboard`);
    await recoveryLogin.page.waitForLoadState("networkidle");
    expect((await assertEncryptedCredential(pool, identity)).used_count).toBe(1);
  } finally {
    await pool.end();
    await Promise.all([initial.close(), totpLogin.close(), recoveryLogin.close()]);
  }
});

test("Operations 本地浏览器首次登录强制绑定并再次用 TOTP 登录", async ({ browser }) => {
  const runtime = await readQualityRuntime();
  const identity = runtime.identities.operationsMaker;
  const enrollment = await createIsolatedQualityBrowser(browser, "operations");
  const verification = await createIsolatedQualityBrowser(browser, "operations");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  try {
    await login(enrollment, identity);
    const { secret } = await completeEnrollment(enrollment);
    await enrollment.page.getByRole("button", { name: "我已安全保存，进入应用" }).click();
    await expect(enrollment.page).toHaveURL(`${enrollment.origin}/`);
    await enrollment.page.waitForLoadState("networkidle");
    await expectAuthenticatedSession(enrollment, identity);
    await expect(enrollment.page.getByRole("heading", { name: "运营概览" })).toBeVisible();

    await login(verification, identity);
    await expect(verification.page.getByRole("heading", { name: "双重验证", exact: true })).toBeVisible();
    await verification.page.getByLabel("动态验证码或恢复码").fill(await currentTotp(secret, 1));
    await verification.page.getByRole("button", { name: "验证并进入" }).click();
    await expect(verification.page).toHaveURL(`${verification.origin}/`);
    await verification.page.waitForLoadState("networkidle");
    await expect(verification.page.getByRole("heading", { name: "运营概览" })).toBeVisible();
    await assertEncryptedCredential(pool, identity);
  } finally {
    await pool.end();
    await Promise.all([enrollment.close(), verification.close()]);
  }
});

test("Maintenance 本地浏览器首次登录强制绑定并用恢复码再次登录", async ({ browser }) => {
  const runtime = await readQualityRuntime();
  const identity = runtime.identities.maintenanceAdmin;
  const enrollment = await createIsolatedQualityBrowser(browser, "maintenance");
  const verification = await createIsolatedQualityBrowser(browser, "maintenance");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  try {
    await login(enrollment, identity);
    const { recoveryCodes } = await completeEnrollment(enrollment);
    await enrollment.page.getByRole("button", { name: "我已安全保存，进入应用" }).click();
    await expect(enrollment.page).toHaveURL(`${enrollment.origin}/`);
    await enrollment.page.waitForLoadState("networkidle");
    await expectAuthenticatedSession(enrollment, identity);
    await expect(enrollment.page.getByRole("heading", { name: "系统概览" })).toBeVisible();

    await login(verification, identity);
    await expect(verification.page.getByRole("heading", { name: "双重验证", exact: true })).toBeVisible();
    await verification.page.getByLabel("动态验证码或恢复码").fill(recoveryCodes[0]);
    await verification.page.getByRole("button", { name: "验证并进入" }).click();
    await expect(verification.page).toHaveURL(`${verification.origin}/`);
    await verification.page.waitForLoadState("networkidle");
    await expect(verification.page.getByRole("heading", { name: "系统概览" })).toBeVisible();
    expect((await assertEncryptedCredential(pool, identity)).used_count).toBe(1);
  } finally {
    await pool.end();
    await Promise.all([enrollment.close(), verification.close()]);
  }
});
