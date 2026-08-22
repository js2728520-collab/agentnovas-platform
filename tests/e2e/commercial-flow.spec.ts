import { randomUUID } from "node:crypto";
import { request, type APIRequestContext, type APIResponse } from "@playwright/test";
import pg from "pg";

import { totpCode } from "../../lib/mfa";
import { qualityApplicationPorts, qualityBrowserOrigin } from "../../scripts/quality/quality-policy.mjs";
import { expect, test } from "./support/quality-test";
import {
  officialRequestHeaders,
  readQualityRuntime,
  type QualityIdentity,
} from "./support/runtime";

const FORBIDDEN_PUBLIC_KEYS = /^(?:password|passwordHash|token|secret|authorization|credential|apiKey|referenceHash|referenceFingerprint(?:Version)?)$/i;

type PlansPayload = {
  orderCreationAvailable: boolean;
  requiredLegalDocuments: Array<{ id: string }>;
  plans: Array<{ code: string; priceUsd: string; priceCurrency: string; aiCredits: number }>;
};
type LegalConsentPayload = {
  consentComplete: boolean;
  requiredLegalDocuments: Array<{ id: string }>;
};
type OrderPayload = { order: { id: string; status: string } };
type EvidencePayload = { evidence: { id: string; referenceMasked: string } };
type ActionPayload = { status: string; paymentEvidenceId?: string; replayed?: boolean };
type ErrorPayload = { error: { code: string } };
type MembershipPayload = { membership: { status: string } | null };
type CreditsPayload = { credits: { available: string; lifetimeGranted: string } };
type PortfolioPayload = { data: Array<Record<string, unknown> & { strategyCode: string }> };
type CustomerPayload = { customers: Array<{ customerId: string; email: string | null }> };

function expectSecretSafe(value: unknown, path = "response") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectSecretSafe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(FORBIDDEN_PUBLIC_KEYS.test(key), `${path}.${key}`).toBe(false);
    expectSecretSafe(child, `${path}.${key}`);
  }
}

async function expectJson<T>(response: APIResponse, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status(), JSON.stringify(payload)).toBe(status);
  expectSecretSafe(payload);
  return payload as T;
}

function mutationHeaders(
  audience: "client" | "operations",
  identity: QualityIdentity,
  idempotencyKey: string,
) {
  return {
    ...officialRequestHeaders(audience, identity),
    "Idempotency-Key": idempotencyKey,
  };
}

async function scopedContext(baseURL: string) {
  return request.newContext({ baseURL });
}

test("four-identity membership evidence and maker-checker activation remains side-effect safe", async ({ page }) => {
  const runtime = await readQualityRuntime();
  const client = await scopedContext(runtime.baseUrls.client);
  const maker = await scopedContext(runtime.baseUrls.operations);
  const checker = await scopedContext(runtime.baseUrls.operations);
  const contexts: APIRequestContext[] = [client, maker, checker];
  const fixtureUrl = new URL(process.env.TEST_DATABASE_URL ?? "");
  expect(fixtureUrl.hostname).toBe("127.0.0.1");
  expect(fixtureUrl.searchParams.get("options")).toBe(`-csearch_path=${runtime.schema}`);
  const fixturePool = new pg.Pool({ connectionString: fixtureUrl.toString(), max: 1 });
  const runId = randomUUID();
  try {
    await fixturePool.query("DELETE FROM commercial_legal_acceptances WHERE user_id=$1", [runtime.identities.client.userId]);
    const blockedPlans = await expectJson<ErrorPayload>(await client.get("/api/membership/plans", {
      headers: officialRequestHeaders("client", runtime.identities.client),
    }), 403);
    expect(blockedPlans.error.code).toBe("LEGAL_CONSENT_REQUIRED");

    const legalPayload = await expectJson<LegalConsentPayload>(await client.get("/api/membership/legal-consent", {
      headers: officialRequestHeaders("client", runtime.identities.client),
    }), 200);
    expect(legalPayload.consentComplete).toBe(false);
    expect(legalPayload.requiredLegalDocuments).toHaveLength(7);

    const clientOrigin = qualityBrowserOrigin("client", qualityApplicationPorts(process.env)).baseURL;
    const clientCookie = {
      value: runtime.identities.client.token,
      domain: runtime.identities.client.domain,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict" as const,
    };
    await page.context().addCookies([
      { ...clientCookie, name: runtime.identities.client.cookieName },
      { ...clientCookie, name: "an_session" },
    ]);
    await page.goto(`${clientOrigin}/workspace`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(`${clientOrigin}/legal/consent?next=%2Fworkspace`);
    await expect(page.getByRole("heading", { name: "商业披露与版本确认" })).toBeVisible();
    await expect(page.locator("article")).toHaveCount(7);
    const confirmButton = page.getByRole("button", { name: "保存当前版本确认" });
    await expect(confirmButton).toBeDisabled();
    await page.getByRole("checkbox").check();
    await confirmButton.click();
    await expect(page.getByText("当前版本确认已完成")).toBeVisible();
    await expect(page.getByText(/3 天试用已在确认后由服务端开通/)).toBeVisible();
    await Promise.all([
      page.waitForURL(`${clientOrigin}/workspace`),
      page.getByRole("link", { name: "继续访问原页面" }).click(),
    ]);

    const confirmedLegal = await expectJson<LegalConsentPayload>(await client.get("/api/membership/legal-consent", {
      headers: officialRequestHeaders("client", runtime.identities.client),
    }), 200);
    expect(confirmedLegal.consentComplete).toBe(true);

    const plansPayload = await expectJson<PlansPayload>(await client.get("/api/membership/plans", {
      headers: officialRequestHeaders("client", runtime.identities.client),
    }), 200);
    expect(plansPayload.orderCreationAvailable).toBe(true);
    expect(plansPayload.requiredLegalDocuments).toHaveLength(7);
    const monthly = plansPayload.plans.find((plan: { code: string }) => plan.code === "monthly_v1");
    expect(monthly).toMatchObject({ priceUsd: "28.00", priceCurrency: "USD", aiCredits: 1000 });

    const orderPayload = await expectJson<OrderPayload>(await client.post("/api/membership/orders", {
      headers: mutationHeaders("client", runtime.identities.client, `quality-order:${runId}`),
      data: {
        planCode: "monthly_v1",
        acceptedDocumentVersionIds: plansPayload.requiredLegalDocuments.map((document: { id: string }) => document.id),
      },
    }), 201);
    const orderId = String(orderPayload.order.id);
    expect(orderPayload.order.status).toBe("AWAITING_EVIDENCE");

    const evidencePayload = await expectJson<EvidencePayload>(await maker.post(`/api/operations/membership-orders/${orderId}/evidence`, {
      headers: mutationHeaders("operations", runtime.identities.operationsMaker, `quality-evidence:${runId}`),
      data: {
        evidenceKind: "bank_transfer",
        providerLabel: "quality-fixture",
        reference: `quality-local-reference-${runId}`,
        amount: "28.00",
        currency: "USD",
        occurredAt: new Date().toISOString(),
        note: "isolated quality evidence; no provider call",
      },
    }), 201);
    expect(evidencePayload.evidence.referenceMasked).not.toContain(runId);
    const paymentEvidenceId = String(evidencePayload.evidence.id);

    const submitted = await expectJson<ActionPayload>(await maker.post(`/api/operations/membership-orders/${orderId}/submit`, {
      headers: mutationHeaders("operations", runtime.identities.operationsMaker, `quality-submit:${runId}`),
    }), 200);
    expect(submitted.status).toBe("SUBMITTED");

    const selfDecision = await expectJson<ErrorPayload>(await maker.post(`/api/operations/membership-orders/${orderId}/decision`, {
      headers: mutationHeaders("operations", runtime.identities.operationsMaker, `quality-self-review:${runId}`),
      data: { decision: "approve", note: "must be rejected", paymentEvidenceId },
    }), 403);
    expect(selfDecision.error.code).toBe("FORBIDDEN");

    const decisionKey = `quality-decision:${runId}`;
    const decisionRequest = {
      headers: mutationHeaders("operations", runtime.identities.operationsChecker, decisionKey),
      data: { decision: "approve", note: "isolated checker approval", paymentEvidenceId },
    };
    const activated = await expectJson<ActionPayload>(await checker.post(`/api/operations/membership-orders/${orderId}/decision`, decisionRequest), 200);
    expect(activated).toMatchObject({ status: "ACTIVATED", paymentEvidenceId, replayed: false });
    const replay = await expectJson<ActionPayload>(await checker.post(`/api/operations/membership-orders/${orderId}/decision`, decisionRequest), 200);
    expect(replay, "an idempotent replay returns the exact original activation resource").toEqual(activated);

    const membership = await expectJson<MembershipPayload>(await client.get("/api/membership/me", {
      headers: officialRequestHeaders("client", runtime.identities.client),
    }), 200);
    expect(membership.membership).toMatchObject({ status: "ACTIVE" });

    const credits = await expectJson<CreditsPayload>(await client.get("/api/credits/me", {
      headers: officialRequestHeaders("client", runtime.identities.client),
    }), 200);
    expect(credits.credits).toMatchObject({ available: "1000", lifetimeGranted: "1000" });

    const portfolios = await expectJson<PortfolioPayload>(await client.get("/api/trading-hall/paper/portfolio", {
      headers: officialRequestHeaders("client", runtime.identities.client),
    }), 200);
    expect(portfolios.data).toHaveLength(3);
    expect(new Set(portfolios.data.map((portfolio: { strategyCode: string }) => portfolio.strategyCode))).toEqual(
      new Set(["ai_conservative", "ai_balanced", "ai_aggressive"]),
    );
    for (const portfolio of portfolios.data) {
      expect(portfolio).toMatchObject({
        initialCashUsdt: "10000.000000000000",
        cashUsdt: "10000.000000000000",
        equityUsdt: "10000.000000000000",
        realizedNetPnlUsdt: "0.000000000000",
        status: "ACTIVE",
        openPositionCount: 0,
      });
    }

    const customerDirectory = await expectJson<CustomerPayload>(await maker.get("/api/organization/customers", {
      headers: officialRequestHeaders("operations", runtime.identities.operationsMaker),
    }), 200);
    const customer = customerDirectory.customers.find((row: { customerId: string }) => row.customerId === runtime.identities.client.userId);
    expect(customer?.email).toBe(runtime.identities.client.email.replace(/^(.{2})[^@]*/, "$1***"));
    expect(JSON.stringify(customerDirectory)).not.toContain(runtime.identities.client.email);

    await page.context().clearCookies();
    const operationsOrigin = qualityBrowserOrigin("operations", qualityApplicationPorts(process.env)).baseURL;
    await page.goto(`${operationsOrigin}/login`);
    await page.getByLabel("邮箱、手机号或用户名").fill(runtime.identities.operationsMaker.email);
    await page.getByLabel("密码").fill(runtime.identities.operationsMaker.password);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("heading", { name: "绑定双重验证" })).toBeVisible();
    const setupKey = await page.locator(".rc-mfa-setup-key").inputValue();
    const code = await totpCode(setupKey, Math.floor(Date.now() / 1000 / 30));
    await page.getByLabel("六位动态验证码").fill(code);
    await page.getByRole("button", { name: "绑定并生成恢复码" }).click();
    await expect(page.getByRole("heading", { name: "保存恢复码" })).toBeVisible();
    await expect(page.locator(".rc-recovery-codes code")).toHaveCount(8);
    await page.getByRole("button", { name: "我已安全保存，进入应用" }).click();
    await expect(page).toHaveURL(`${operationsOrigin}/`);
    await expect(page.getByRole("heading", { name: "运营概览" })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
    await fixturePool.end();
  }
});
