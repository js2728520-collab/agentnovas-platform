import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ACTIVE_SESSIONS, sessionIdsToRevoke } from "../lib/session-policy.ts";

test("keeps at most three simultaneous sessions when a new login is added", () => {
  assert.equal(MAX_ACTIVE_SESSIONS, 3);
  assert.deepEqual(sessionIdsToRevoke([]), []);
  assert.deepEqual(sessionIdsToRevoke(["newest"]), []);
  assert.deepEqual(sessionIdsToRevoke(["newest", "middle"]), []);
  assert.deepEqual(sessionIdsToRevoke(["newest", "middle", "oldest"]), ["oldest"]);
  assert.deepEqual(sessionIdsToRevoke(["newest", "middle", "old", "oldest"]), ["old", "oldest"]);
});
