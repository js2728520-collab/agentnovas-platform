import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("login form fails to POST instead of leaking credentials into a GET URL before hydration", async () => {
  const source = await readFile(new URL("../packages/ui/src/app-login.tsx", import.meta.url), "utf8");
  assert.match(source, /<form method="post" onSubmit=\{submit\}/);
  assert.doesNotMatch(source, /<form onSubmit=\{submit\}/);
});
