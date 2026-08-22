import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSessionAssurance } from "../lib/session-assurance.ts";

const now = new Date("2026-08-20T12:00:00.000Z");
const base = {
  audience: "operations",
  idleExpiresAt: "2026-08-20T13:00:00.000Z",
  absoluteExpiresAt: "2026-08-21T00:00:00.000Z",
  mfaLevel: "totp",
  mfaVerifiedAt: "2026-08-20T11:50:00.000Z",
};

test("internal sessions require completed MFA and both expiry bounds", () => {
  assert.deepEqual(evaluateSessionAssurance(base, now), { usable: true, recentMfa: true });
  assert.deepEqual(evaluateSessionAssurance({ ...base, mfaLevel: "primary", mfaVerifiedAt: null }, now), {
    usable: false,
    recentMfa: false,
  });
  assert.deepEqual(evaluateSessionAssurance({ ...base, idleExpiresAt: now.toISOString() }, now), {
    usable: false,
    recentMfa: false,
  });
});
test("a primary internal session is usable only for the MFA completion endpoint", () => {
  assert.deepEqual(evaluateSessionAssurance(
    { ...base, mfaLevel: "primary", mfaVerifiedAt: null }, now, { allowPrimaryInternal: true },
  ), { usable: true, recentMfa: false });
});

test("recent MFA expires after fifteen minutes while the session remains usable", () => {
  assert.deepEqual(evaluateSessionAssurance({ ...base, mfaVerifiedAt: "2026-08-20T11:44:59.000Z" }, now), {
    usable: true,
    recentMfa: false,
  });
});

test("client primary sessions do not require internal MFA", () => {
  assert.deepEqual(evaluateSessionAssurance({ ...base, audience: "client", mfaLevel: "primary", mfaVerifiedAt: null }, now), {
    usable: true,
    recentMfa: false,
  });
});
