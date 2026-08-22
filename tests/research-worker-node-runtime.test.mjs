import assert from "node:assert/strict";
import test from "node:test";

test("loads the research worker credential dependency in native Node.js", async () => {
  const credentials = await import("../lib/exchange-credentials.ts");
  assert.equal(typeof credentials.decryptExchangeCredential, "function");
});
