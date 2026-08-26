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

test("an internal session without MFA is usable only when enforcement is explicitly disabled", () => {
  assert.deepEqual(evaluateSessionAssurance(
    { ...base, mfaLevel: "none", mfaVerifiedAt: null }, now, { mfaEnforced: false },
  ), { usable: true, recentMfa: false });
  assert.deepEqual(evaluateSessionAssurance(
    { ...base, mfaLevel: "none", mfaVerifiedAt: null }, now, { mfaEnforced: true },
  ), { usable: false, recentMfa: false });
  assert.deepEqual(evaluateSessionAssurance(
    { ...base, mfaLevel: "primary", mfaVerifiedAt: null }, now, { mfaEnforced: false },
  ), { usable: false, recentMfa: false });
  assert.deepEqual(evaluateSessionAssurance(
    { ...base, mfaLevel: "primary", mfaVerifiedAt: null }, now,
    { mfaEnforced: false, allowPrimaryInternal: true },
  ), { usable: true, recentMfa: false });
});

test("recent MFA expires after fifteen minutes while the session remains usable", () => {
  assert.deepEqual(evaluateSessionAssurance({ ...base, mfaVerifiedAt: "2026-08-20T11:44:59.000Z" }, now), {
    usable: true,
    recentMfa: false,
  });
});

test("an enrolled Client cannot retain an unverified session when enforcement switches on", () => {
  const client = { ...base, audience: "client", mfaEnrolled: true, mfaVerifiedAt: null };
  assert.deepEqual(evaluateSessionAssurance({ ...client, mfaLevel: "none" }, now, { mfaEnforced: true }), {
    usable: false,
    recentMfa: false,
  });
  assert.deepEqual(evaluateSessionAssurance({ ...client, mfaLevel: "primary" }, now, { mfaEnforced: true }), {
    usable: false,
    recentMfa: false,
  });
  assert.deepEqual(evaluateSessionAssurance(
    { ...client, mfaLevel: "primary" }, now,
    { mfaEnforced: true, allowPrimaryInternal: true },
  ), { usable: true, recentMfa: false });
  assert.deepEqual(evaluateSessionAssurance({ ...client, mfaLevel: "none" }, now, { mfaEnforced: false }), {
    usable: true,
    recentMfa: false,
  });
});
