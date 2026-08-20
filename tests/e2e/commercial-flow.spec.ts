import { randomUUID } from "node:crypto";
import { request, type APIRequestContext, type APIResponse } from "@playwright/test";

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

test("four-identity membership evidence and maker-checker activation remains side-effect safe", async () => {
  const runtime = await readQualityRuntime();
  const client = await scopedContext(runtime.baseUrls.client);
  const maker = await scopedContext(runtime.baseUrls.operations);
  const checker = await scopedContext(runtime.baseUrls.operations);
  const contexts: APIRequestContext[] = [client, maker, checker];
  const runId = randomUUID();
  try {
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
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
  }
});
