import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("quality browser hosts are explicitly allowed to load Next development assets", async () => {
  const config = await read("next.config.ts");

  for (const host of ["agentnovas.com", "zht.agentnovas.com", "xm.agentnovas.com"]) {
    assert.match(config, new RegExp(`"${host}"`));
  }
  assert.match(config, /allowedDevOrigins:\s*\[\.\.\.qualityDevOrigins, "127\.0\.0\.1"\]/);
});
