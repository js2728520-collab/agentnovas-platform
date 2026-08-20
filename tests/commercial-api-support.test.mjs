import assert from "node:assert/strict";
import test from "node:test";

import {
  PAYMENT_REFERENCE_FINGERPRINT_VERSION,
  decodeCommercialCursor,
  encodeCommercialCursor,
  fingerprintPaymentReference,
  maskPaymentReference,
  normalizePaymentReference,
  previousCompleteUtcWeek,
} from "../lib/commercial-api-support.ts";
import {
  idempotencyKey,
  paymentEvidenceInput,
} from "../lib/commercial-request-validation.ts";

test("commercial cursors round trip and reject untrusted input", () => {
  const cursor = { createdAt: "2026-08-20T00:00:00.000Z", id: "order-1" };
  assert.deepEqual(
    decodeCommercialCursor(encodeCommercialCursor(cursor)),
    cursor,
  );
  assert.throws(
    () => decodeCommercialCursor("not-a-cursor"),
    /COMMERCIAL_CURSOR_INVALID/,
  );
});

test("payment evidence keeps only a masked suffix", () => {
  assert.equal(maskPaymentReference("BANK-SECRET-12345678"), "********5678");
  assert.equal(maskPaymentReference("123"), "****");
});

test("previous complete UTC week is Monday-exclusive Monday", () => {
  assert.deepEqual(previousCompleteUtcWeek(new Date("2026-08-20T13:00:00Z")), {
    weekStart: "2026-08-10T00:00:00.000Z",
    weekEnd: "2026-08-17T00:00:00.000Z",
  });
});

test("write boundaries require header idempotency and reject malformed evidence as 4xx", () => {
  assert.throws(
    () => idempotencyKey(new Request("https://example.test")),
    (error) =>
      error.status === 422 && error.code === "IDEMPOTENCY_KEY_REQUIRED",
  );
  assert.equal(
    idempotencyKey(
      new Request("https://example.test", {
        headers: { "Idempotency-Key": "actor-resource-1" },
      }),
    ),
    "actor-resource-1",
  );
  for (const body of [
    {
      evidenceKind: "raw_payload",
      reference: "ref",
      amount: "1",
      currency: "USD",
      occurredAt: "2026-08-20",
    },
    {
      evidenceKind: "bank_transfer",
      reference: "ref",
      amount: "0",
      currency: "USD",
      occurredAt: "2026-08-20",
    },
    {
      evidenceKind: "bank_transfer",
      reference: "ref",
      amount: "1",
      currency: "USDT",
      occurredAt: "2026-08-20",
    },
    {
      evidenceKind: "bank_transfer",
      reference: "ref",
      amount: "1",
      currency: "USD",
      occurredAt: "2999-01-01",
    },
    {
      evidenceKind: "bank_transfer",
      reference: "ref",
      amount: "1",
      currency: "USD",
      occurredAt: "2026-08-20",
      note: "x".repeat(501),
    },
  ])
    assert.throws(
      () => paymentEvidenceInput(body, "USD"),
      (error) => error.status === 422 && error.code === "VALIDATION_ERROR",
    );
});

test("payment references use one Unicode, whitespace and case-normalized fingerprint", () => {
  assert.equal(PAYMENT_REFERENCE_FINGERPRINT_VERSION, "nfkc-upper-v2");
  const canonical = "WIRE REF 001";
  assert.equal(normalizePaymentReference("  wire   ref  001  "), canonical);
  assert.equal(normalizePaymentReference("ｗｉｒｅ ref ００１"), canonical);
  assert.equal(
    fingerprintPaymentReference("  wire   ref  001  "),
    fingerprintPaymentReference("ｗｉｒｅ ref ００１"),
  );
});
