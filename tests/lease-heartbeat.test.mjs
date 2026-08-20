import assert from "node:assert/strict";
import test from "node:test";

import { startLeaseHeartbeat } from "../lib/lease-heartbeat.ts";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("generic lease heartbeat renews serially and stops cleanly", async () => {
  let renewals = 0;
  let inFlight = 0;
  let maximumInFlight = 0;
  const stop = startLeaseHeartbeat({
    leaseSeconds: 5,
    intervalMs: 10,
    async renew() {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await wait(4);
      renewals += 1;
      inFlight -= 1;
    },
  });
  await wait(38);
  await stop();
  const stoppedAt = renewals;
  await wait(20);
  assert.ok(stoppedAt >= 2);
  assert.equal(renewals, stoppedAt);
  assert.equal(maximumInFlight, 1);
});

test("generic lease heartbeat reports renewal errors and continues", async () => {
  let renewals = 0;
  const errors = [];
  const stop = startLeaseHeartbeat({
    leaseSeconds: 5,
    intervalMs: 10,
    async renew() {
      renewals += 1;
      if (renewals === 1) throw new Error("fixture renewal failure");
    },
    onRenewalError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });
  await wait(32);
  await stop();
  assert.ok(renewals >= 2);
  assert.deepEqual(errors, ["fixture renewal failure"]);
});
