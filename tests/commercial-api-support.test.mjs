import assert from "node:assert/strict";
import test from "node:test";

import { decodeCommercialCursor, encodeCommercialCursor, maskPaymentReference, previousCompleteUtcWeek } from "../lib/commercial-api-support.ts";

test("commercial cursors round trip and reject untrusted input", () => {
  const cursor = { createdAt: "2026-08-20T00:00:00.000Z", id: "order-1" };
  assert.deepEqual(decodeCommercialCursor(encodeCommercialCursor(cursor)), cursor);
  assert.throws(() => decodeCommercialCursor("not-a-cursor"), /COMMERCIAL_CURSOR_INVALID/);
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
