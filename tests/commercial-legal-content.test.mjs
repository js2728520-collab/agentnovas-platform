import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  commercialLegalContentSha256,
  hasReadableCommercialLegalContent,
} from "../lib/commercial-legal.ts";

const body = "Approved beta legal document body for automated testing only.";

test("commercial legal content must be readable and match its immutable digest", () => {
  const row = {
    id: "terms-v1",
    document_type: "terms",
    version: 1,
    content_sha256: commercialLegalContentSha256(body),
    content_locale: "en-US",
    content_markdown: body,
  };
  assert.equal(hasReadableCommercialLegalContent(row), true);
  assert.equal(hasReadableCommercialLegalContent({ ...row, content_markdown: null }), false);
  assert.equal(hasReadableCommercialLegalContent({ ...row, content_markdown: `${body} changed` }), false);
});

test("membership order creation and UI fail closed until all legal bodies are readable", async () => {
  const route = await readFile(new URL("../app/api/membership/plans/route.client.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../lib/commercial-membership-service.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../apps/client/ui/membership-experience.tsx", import.meta.url), "utf8");
  assert.match(route, /content_markdown/);
  assert.match(route, /hasReadableCommercialLegalContent/);
  assert.match(service, /result\.rows\.some\(\(row\) => !hasReadableCommercialLegalContent\(row\)\)/);
  assert.match(ui, /contentMarkdown/);
  assert.match(ui, /我已阅读并同意以上服务说明/);
  assert.match(ui, /!acknowledged \|\| !data\.orderCreationAvailable/);
  assert.doesNotMatch(ui, /以上七份正文/);
  assert.doesNotMatch(ui, /idempotency-key": newIdempotencyKey\(\)/);
});
