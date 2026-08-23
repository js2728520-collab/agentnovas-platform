import { randomUUID } from "node:crypto";
import pg from "pg";

import { qualityApplicationPorts, qualityBrowserOrigin } from "../../scripts/quality/quality-policy.mjs";
import { createIsolatedQualityBrowser, expect, test } from "./support/quality-test";
import { readQualityRuntime } from "./support/runtime";

type IsolatedPage = Awaited<ReturnType<typeof createIsolatedQualityBrowser>>["page"];

async function closeAllBrowsers(closures: Array<Promise<void>>) {
  const closeResults = await Promise.allSettled(closures);
  const failedClose = closeResults.find((result) => result.status === "rejected");
  if (failedClose?.status === "rejected") throw failedClose.reason;
}

async function login(page: IsolatedPage, email: string, password: string) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("邮箱、手机号或用户名").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
}

async function authenticateInBrowser(page: IsolatedPage, email: string, password: string) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  return page.evaluate(async ({ identifier, passwordValue }) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, password: passwordValue }),
    });
    return { status: response.status, payload: await response.json() };
  }, { identifier: email, passwordValue: password });
}

test("Client、Operations、Maintenance 从空浏览器登录后进入各自首页", async ({ browser }) => {
  const runtime = await readQualityRuntime();
  const cases = [
    ["client", runtime.identities.client, "/dashboard", /欢迎回来/],
    ["operations", runtime.identities.operationsMaker, "/", "运营概览"],
    ["maintenance", runtime.identities.maintenanceAdmin, "/", "系统概览"],
  ] as const;
  const contexts = await Promise.all(cases.map(([audience]) => createIsolatedQualityBrowser(browser, audience)));
  try {
    for (let index = 0; index < cases.length; index += 1) {
      const [, identity, path, heading] = cases[index];
      const isolated = contexts[index];
      await login(isolated.page, identity.email, identity.password);
      await expect(isolated.page).toHaveURL(`${isolated.origin}${path}`);
      await expect(isolated.page.getByRole("heading", { name: heading })).toBeVisible();
      await isolated.page.waitForLoadState("networkidle");
      await expect(isolated.page.getByRole("heading", { name: "绑定双重验证" })).toHaveCount(0);
    }
  } finally {
    await closeAllBrowsers(contexts.map((isolated) => isolated.close()));
  }
});

test("Operations 权限链接完成浏览器注册、冻结角色和作废闭环", async ({ browser, page }) => {
  const runtime = await readQualityRuntime();
  const issuer = runtime.identities.operationsChecker;
  const operationsOrigin = qualityBrowserOrigin("operations", qualityApplicationPorts(process.env)).baseURL;
  const invitationsPath = "/invitations";
  await page.context().addCookies([{
    name: issuer.cookieName,
    value: issuer.token,
    domain: issuer.domain,
    path: "/",
    expires: Math.floor(new Date(runtime.expiresAt).getTime() / 1000),
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  }]);
  await page.goto(`${operationsOrigin}${invitationsPath}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "权限注册链接" })).toBeVisible();
  await page.getByLabel("授予角色").selectOption("employee");
  await page.getByRole("button", { name: "生成或重新生成链接" }).click();
  const registrationLink = await page.locator("code").filter({ hasText: "/login#" }).textContent();
  expect(registrationLink).toMatch(/^https:\/\/zht\.agentnovas\.com(?::\d+)?\/login#staff-invite=/);

  const registrant = await createIsolatedQualityBrowser(browser, "operations");
  const email = `g1-employee-${runtime.schema.slice(-10)}@quality.invalid`;
  const password = `G1-local-${randomUUID()}!`;
  try {
    await registrant.page.goto(String(registrationLink), { waitUntil: "domcontentloaded" });
    await expect(registrant.page.getByRole("heading", { name: "加入团队" })).toBeVisible();
    await registrant.page.getByLabel("邮箱").fill(email);
    await registrant.page.getByLabel(/密码（至少 12 位）/).fill(password);
    await registrant.page.getByRole("button", { name: "提交注册" }).click();
    await expect(registrant.page.getByText(/账号权限已立即生效/)).toBeVisible();
    await registrant.page.getByRole("link", { name: "返回登录" }).click();
    await login(registrant.page, email, password);
    await expect(registrant.page).toHaveURL(`${operationsOrigin}/`);
    await expect(registrant.page.getByRole("heading", { name: "绑定双重验证" })).toHaveCount(0);
    await expect(registrant.page.getByRole("heading", { name: "运营概览" })).toBeVisible();
  } finally {
    await registrant.close();
  }

  const fixturePool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  try {
    const assigned = await fixturePool.query(`
      SELECT account.role,assignment.status,role.code,
             (SELECT count(*)::int FROM internal_registration_link_uses WHERE registered_user_id=account.id) AS uses,
             (SELECT count(*)::int FROM invitations WHERE used_by_user_id=account.id) AS customer_invitation_uses
        FROM users AS account
        JOIN user_role_assignments AS assignment ON assignment.user_id=account.id AND assignment.status='active'
        JOIN roles AS role ON role.id=assignment.role_id
       WHERE account.email=$1
    `, [email]);
    expect(assigned.rows[0]).toMatchObject({
      role: "employee",
      status: "active",
      uses: 1,
      customer_invitation_uses: 0,
    });
    expect(String(assigned.rows[0].code)).toMatch(/^registration_link_[a-f0-9]{32}$/);
  } finally {
    await fixturePool.end();
  }

  await page.getByRole("button", { name: "立即作废" }).click();
  await expect(page.getByText("已作废").first()).toBeVisible();
  const rejected = await createIsolatedQualityBrowser(browser, "operations");
  try {
    await rejected.page.goto(String(registrationLink), { waitUntil: "domcontentloaded" });
    const rejectedResult = await rejected.page.evaluate(async ({ email, password }) => {
      const response = await fetch("/api/organization/staff-register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: window.location.href, email, password }),
      });
      return { status: response.status, payload: await response.json() };
    }, {
      email: `g1-rejected-${runtime.schema.slice(-10)}@quality.invalid`,
      password: `G1-rejected-${randomUUID()}!`,
    });
    expect(rejectedResult.status).toBe(400);
    expect(JSON.stringify(rejectedResult.payload)).toMatch(/无效或已作废/);
  } finally {
    await rejected.close({ allowedStatuses: [400] });
  }
});

test("Client 五个浏览器、第六台拒绝、全量退出和邮件关闭降级形成闭环", async ({ browser }) => {
  test.setTimeout(180_000);
  const runtime = await readQualityRuntime();
  const identity = runtime.identities.clientSecurity;
  const contexts: Array<Awaited<ReturnType<typeof createIsolatedQualityBrowser>>> = [];
  const rejected = await createIsolatedQualityBrowser(browser, "client");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  try {
    await test.step("五个隔离浏览器登录且第六台被拒绝", async () => {
      expect(process.env.NOTIFICATION_EMAIL_SEND_ENABLED).toBe("false");
      for (let index = 0; index < 5; index += 1) {
        const isolated = await createIsolatedQualityBrowser(browser, "client");
        contexts.push(isolated);
      }
      await Promise.all(contexts.map(async (isolated) => {
        const result = await authenticateInBrowser(isolated.page, identity.email, identity.password);
        expect(result).toMatchObject({ status: 200, payload: { mfaRequired: false } });
        await isolated.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
        await expect(isolated.page).toHaveURL(`${isolated.origin}/dashboard`);
      }));
      const rejectedLogin = await authenticateInBrowser(rejected.page, identity.email, identity.password);
      expect(rejectedLogin.status).toBe(409);
      expect(JSON.stringify(rejectedLogin.payload)).toMatch(/已登录 5 台设备/);
    });

    await test.step("新设备双通道通知保持排队事实", async () => {
      const deliveryState = await pool.query(`
      SELECT channel,status,count(*)::int AS count
        FROM notification_deliveries
       WHERE user_id=$1 AND template_key='security_new_device'
       GROUP BY channel,status ORDER BY channel,status
    `, [identity.userId]);
      expect(deliveryState.rows).toEqual([
        { channel: "email", status: "queued", count: 5 },
        { channel: "in_app", status: "queued", count: 5 },
      ]);
    });

    await test.step("账户安全页撤销全部浏览器会话", async () => {
      const controller = contexts[0];
      await controller.page.goto("/account/security", { waitUntil: "domcontentloaded" });
      await expect(controller.page.getByRole("heading", { name: "登录设备（最多 5 台）" })).toBeVisible();
      await expect(controller.page.getByRole("button", { name: "退出全部设备", exact: true })).toBeVisible();
      const revokeResult = await controller.page.evaluate(async () => {
        const response = await fetch("/api/account/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "G1 多浏览器全量退出验收" }),
        });
        return { status: response.status, payload: await response.json() };
      });
      expect(revokeResult).toMatchObject({ status: 200, payload: { ok: true } });
      await controller.page.goto("/login", { waitUntil: "domcontentloaded" });
      await expect(controller.page.getByRole("heading", { name: "安全登录" })).toBeVisible();

      await contexts[1].page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      await expect(contexts[1].page).toHaveURL(/\/login\?next=/);
      expect(Number((await pool.query(`
      SELECT count(*)::int AS count FROM sessions
       WHERE user_id=$1 AND app_audience='client' AND revoked_at IS NULL
      `, [identity.userId])).rows[0].count)).toBe(0);
    });

    await test.step("邮箱未验证时重发并保留加密 outbox", async () => {
      await pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [identity.userId]);
      const verification = await createIsolatedQualityBrowser(browser, "client");
      contexts.push(verification);
      await login(verification.page, identity.email, identity.password);
      await expect(verification.page.getByText(/请先完成邮箱验证/)).toBeVisible();
      await verification.page.getByRole("button", { name: "重发验证邮件" }).click();
      await verification.page.getByRole("textbox", { name: "账户邮箱" }).fill(identity.email);
      await verification.page.getByRole("button", { name: "重发验证邮件" }).click();
      await expect(verification.page.getByText(/验证邮件已进入发送队列/)).toBeVisible();
      const verificationEvidence = await pool.query(`
      SELECT token.used_at,token.expires_at,delivery.status AS delivery_status,delivery.payload_json
        FROM auth_tokens AS token
        JOIN notification_deliveries AS delivery
          ON delivery.user_id=token.user_id AND delivery.template_key='verify_email'
       WHERE token.user_id=$1 AND token.purpose='verify_email'
       ORDER BY token.created_at DESC,delivery.created_at DESC LIMIT 1
    `, [identity.userId]);
      expect(verificationEvidence.rows[0]).toMatchObject({ used_at: null, delivery_status: "queued" });
      expect(new Date(verificationEvidence.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
      const payload = typeof verificationEvidence.rows[0].payload_json === "string"
        ? JSON.parse(verificationEvidence.rows[0].payload_json)
        : verificationEvidence.rows[0].payload_json;
      expect(payload.encryptedToken).toMatch(/^v1\./);
      expect(payload).not.toHaveProperty("token");
    });
  } finally {
    await pool.end();
    await closeAllBrowsers([
      ...contexts.map((isolated) => isolated.close({ allowedStatuses: [401, 403] })),
      rejected.close({ allowedStatuses: [409] }),
    ]);
  }
});
