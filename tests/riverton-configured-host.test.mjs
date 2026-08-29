import assert from "node:assert/strict";
import test from "node:test";

import { resolveAppAudienceStrict } from "../lib/riverton-apps.ts";

test("uses the exact configured deployment host for a fixed audience", () => {
  const environment = {
    RIVERTON_APP_AUDIENCE: "maintenance",
    RIVERTON_APP_HOST: "main-test.agentnovas.com",
  };

  assert.equal(resolveAppAudienceStrict({
    host: "main-test.agentnovas.com",
    environment,
  }), "maintenance");
  assert.equal(resolveAppAudienceStrict({
    host: "xm.agentnovas.com",
    environment,
  }), null);
  assert.equal(resolveAppAudienceStrict({
    host: "ops-test.agentnovas.com",
    environment,
  }), null);
});

test("fails closed for malformed configured deployment hosts", () => {
  for (const configuredHost of [
    "https://main-test.agentnovas.com",
    "main-test.agentnovas.com:443",
    "main-test.agentnovas.com,attacker.example",
    "localhost",
    "127.0.0.1",
    "-invalid.agentnovas.com",
    "invalid-.agentnovas.com",
  ]) {
    assert.equal(resolveAppAudienceStrict({
      host: "main-test.agentnovas.com",
      environment: {
        RIVERTON_APP_AUDIENCE: "maintenance",
        RIVERTON_APP_HOST: configuredHost,
      },
    }), null, configuredHost);
  }
});

test("keeps the canonical production host when no deployment override exists", () => {
  assert.equal(resolveAppAudienceStrict({
    host: "xm.agentnovas.com",
    environment: { RIVERTON_APP_AUDIENCE: "maintenance" },
  }), "maintenance");
});
