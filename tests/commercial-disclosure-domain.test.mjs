import assert from "node:assert/strict";
import test from "node:test";

import {
  commercialDisclosureSnapshotHash,
  normalizeCommercialDisclosureSubmission,
} from "../lib/commercial-disclosure.ts";
import { requiredLegalDocumentTypes } from "../packages/domain/src/commercial-membership-domain.ts";

const content = (type) => `# ${type}\n\n本正文用于说明 Riverton Capital Paper SaaS 的产品边界、客户权利、操作流程与风险，不包含真实交易或资金托管。`;

function validInput() {
  return {
    locale: "zh-CN",
    reason: "发布首个可收费版本的商业披露",
    productIdentity: {
      operatorName: "Riverton Capital",
      serviceRegion: "受邀用户可访问的线上服务区域",
      supportEmail: "support@example.test",
      primaryDomain: "agentnovas.com",
    },
    documents: Object.fromEntries(requiredLegalDocumentTypes.map((type) => [type, content(type)])),
  };
}

test("commercial disclosure submission normalizes one complete seven-document bundle", () => {
  const normalized = normalizeCommercialDisclosureSubmission(validInput());
  assert.equal(normalized.locale, "zh-CN");
  assert.deepEqual(normalized.documents.map((document) => document.type), [...requiredLegalDocumentTypes]);
  assert.ok(normalized.documents.every((document) => document.contentSha256.length === 64));
  assert.equal(normalized.productIdentity.supportEmail, "support@example.test");
  assert.equal(normalized.productIdentity.primaryDomain, "agentnovas.com");
});

test("commercial disclosure submission fails closed for missing identity, documents, weak reasons, or unsafe domains", () => {
  const missingIdentity = validInput();
  missingIdentity.productIdentity.operatorName = "";
  assert.throws(() => normalizeCommercialDisclosureSubmission(missingIdentity), /DISCLOSURE_IDENTITY_INCOMPLETE/);

  const missingDocument = validInput();
  delete missingDocument.documents.refund_policy;
  assert.throws(() => normalizeCommercialDisclosureSubmission(missingDocument), /DISCLOSURE_DOCUMENT_SET_INVALID/);

  const weakReason = validInput();
  weakReason.reason = "ok";
  assert.throws(() => normalizeCommercialDisclosureSubmission(weakReason), /DISCLOSURE_REASON_INVALID/);

  const unsafeDomain = validInput();
  unsafeDomain.productIdentity.primaryDomain = "https://user:secret@example.test/path";
  assert.throws(() => normalizeCommercialDisclosureSubmission(unsafeDomain), /DISCLOSURE_DOMAIN_INVALID/);
});

test("commercial disclosure snapshot hash is stable across input key order and changes with content", () => {
  const first = normalizeCommercialDisclosureSubmission(validInput());
  const reversedInput = validInput();
  reversedInput.documents = Object.fromEntries(Object.entries(reversedInput.documents).reverse());
  const second = normalizeCommercialDisclosureSubmission(reversedInput);
  assert.equal(commercialDisclosureSnapshotHash(first), commercialDisclosureSnapshotHash(second));

  const changedInput = validInput();
  changedInput.documents.terms += "\n\n新增版本条款。";
  const changed = normalizeCommercialDisclosureSubmission(changedInput);
  assert.notEqual(commercialDisclosureSnapshotHash(first), commercialDisclosureSnapshotHash(changed));
});
