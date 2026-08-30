import assert from "node:assert/strict";
import test from "node:test";

import { createPublicHttpsEndpointPolicy } from "../lib/ai-gateway-endpoint-policy.ts";

test("AgentNovas endpoint policy returns pinned public addresses only", async () => {
  const policy = createPublicHttpsEndpointPolicy({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.deepEqual(await policy.assertAllowed("https://provider.example/v1"), {
    endpoint: "https://provider.example/v1",
    hostname: "provider.example",
    pinnedAddresses: ["93.184.216.34"],
  });
});

test("AgentNovas endpoint policy rejects credential URLs, query keys, private DNS and rebinding candidates", async () => {
  const publicPolicy = createPublicHttpsEndpointPolicy({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  for (const endpoint of [
    "http://provider.example/v1",
    "https://user:password@provider.example/v1",
    "https://provider.example/v1?api_key=secret",
    "https://127.0.0.1/v1",
  ]) await assert.rejects(publicPolicy.assertAllowed(endpoint), (error) => error?.code === "AI_ENDPOINT_BLOCKED");

  const mixedDnsPolicy = createPublicHttpsEndpointPolicy({
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ],
  });
  await assert.rejects(mixedDnsPolicy.assertAllowed("https://provider.example/v1"), (error) => error?.code === "AI_ENDPOINT_BLOCKED");
});
