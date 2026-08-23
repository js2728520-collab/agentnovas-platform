import assert from "node:assert/strict";
import test from "node:test";

import { apiPolicyForRoute } from "../lib/api-policy.ts";

test("体验账号读取不依赖浏览器不会发送的 Origin 头，写入仍强制同源", () => {
  const readPolicy = apiPolicyForRoute("/api/organization/experience-account", "GET");
  const writePolicy = apiPolicyForRoute("/api/organization/experience-account", "POST");
  assert.equal(readPolicy.requiresSameOrigin, false);
  assert.equal(writePolicy.requiresSameOrigin, true);
  assert.deepEqual(readPolicy.audiences, ["operations", "maintenance"]);
  assert.equal(readPolicy.authentication, "session");
});
