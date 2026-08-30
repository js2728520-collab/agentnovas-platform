import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveEmailServiceEffectiveStatus,
  emailDeliveryErrorKind,
  maskEmailAddress,
  normalizeEmailConfigurationCommand,
  normalizeEmailRecipientCommand,
  normalizeEmailRecipientCreateCommand,
  normalizeEmailRecipientVerificationCommand,
  normalizeEmailSecretRequestCommand,
  normalizeEmailTestHistoryLimit,
} from "../packages/notifications/src/email-service-management.ts";

const readyGates = {
  apiKeyPresent: true,
  webhookSecretPresent: true,
  senderDomainVerified: true,
  templatesReady: true,
  suppressionReady: true,
  workerEnabled: true,
  environmentSendEnabled: true,
  providerAuthorized: true,
};

test("email service status does not report ready beside a newer failed test", () => {
  assert.equal(deriveEmailServiceEffectiveStatus({ gates: readyGates, latestTestStatus: "delivered" }), "ready");
  assert.equal(deriveEmailServiceEffectiveStatus({ gates: readyGates, latestTestStatus: "failed" }), "degraded");
  assert.equal(deriveEmailServiceEffectiveStatus({ gates: { ...readyGates, workerEnabled: false }, latestTestStatus: null }), "degraded");
  assert.equal(deriveEmailServiceEffectiveStatus({ gates: { ...readyGates, providerAuthorized: false }, latestTestStatus: null }), "disabled");
  assert.equal(deriveEmailServiceEffectiveStatus({ gates: { ...readyGates, apiKeyPresent: false }, latestTestStatus: null }), "unconfigured");
});

test("email configuration command is strict, normalized and requires an audit reason", () => {
  assert.deepEqual(normalizeEmailConfigurationCommand({
    action: "activate",
    reason: "  验证测试投递链路  ",
  }), { action: "activate", reason: "验证测试投递链路" });
  assert.throws(() => normalizeEmailConfigurationCommand({ action: "activate", reason: "no", extra: true }), /EMAIL_CONFIGURATION_FIELDS_INVALID/);
  assert.throws(() => normalizeEmailConfigurationCommand({ action: "rotate_key", reason: "不能通过浏览器轮换" }), /EMAIL_CONFIGURATION_ACTION_INVALID/);
  assert.throws(() => normalizeEmailConfigurationCommand({ action: "disable", reason: "x" }), /EMAIL_CONFIGURATION_REASON_INVALID/);
});

test("independent recipient commands are strict and never infer the signed-in account email", () => {
  assert.deepEqual(normalizeEmailRecipientCreateCommand({
    email: "  QA.Owner+Mail@Example.COM ",
    label: "  外部验收邮箱  ",
    reason: "  新增独立测试收件地址  ",
  }), {
    email: "qa.owner+mail@example.com",
    label: "外部验收邮箱",
    reason: "新增独立测试收件地址",
  });
  assert.deepEqual(normalizeEmailRecipientVerificationCommand({
    action: "verify",
    code: "042019",
    reason: "验证收件邮箱所有权",
  }), { action: "verify", code: "042019", reason: "验证收件邮箱所有权" });
  assert.deepEqual(normalizeEmailRecipientVerificationCommand({
    action: "resend",
    reason: "原验证码已经过期",
  }), { action: "resend", reason: "原验证码已经过期" });
  assert.deepEqual(normalizeEmailRecipientCommand({ action: "disable", reason: "暂停该验收邮箱" }), {
    action: "disable",
    reason: "暂停该验收邮箱",
  });
  assert.throws(() => normalizeEmailRecipientCreateCommand({ email: "invalid", label: "测试", reason: "新增测试地址" }), /EMAIL_RECIPIENT_ADDRESS_INVALID/);
  assert.throws(() => normalizeEmailRecipientVerificationCommand({ action: "verify", code: "12345", reason: "验证测试地址" }), /EMAIL_RECIPIENT_CODE_INVALID/);
  assert.throws(() => normalizeEmailRecipientCommand({ action: "delete", reason: "绕过删除接口" }), /EMAIL_RECIPIENT_ACTION_INVALID/);
});

test("write-only secret requests accept only a bounded encrypted envelope", () => {
  const envelope = {
    version: "v1",
    keyId: "email-broker-2026-08",
    wrappedKey: "A".repeat(342),
    iv: "A".repeat(16),
    ciphertext: "A".repeat(160),
  };
  assert.deepEqual(normalizeEmailSecretRequestCommand({
    operation: "rotate",
    envelope,
    reason: "轮换 Resend 密钥并保留旧配置直到原子切换",
  }), {
    operation: "rotate",
    envelope,
    reason: "轮换 Resend 密钥并保留旧配置直到原子切换",
  });
  assert.throws(() => normalizeEmailSecretRequestCommand({
    operation: "rotate",
    envelope: { ...envelope, privateKey: "never" },
    reason: "拒绝额外秘密字段",
  }), /EMAIL_SECRET_ENVELOPE_FIELDS_INVALID/);
  assert.throws(() => normalizeEmailSecretRequestCommand({
    operation: "read",
    envelope,
    reason: "禁止读取密钥",
  }), /EMAIL_SECRET_OPERATION_INVALID/);
});

test("recipient display preserves the current operator address and masks other addresses", () => {
  assert.equal(maskEmailAddress("operator@example.com"), "o••••••r@example.com");
  assert.equal(maskEmailAddress("a@example.com"), "a@example.com");
  assert.equal(maskEmailAddress("not-an-email"), "••••••••");
});

test("delivery errors map to stable actionable kinds without hiding unknown codes", () => {
  assert.deepEqual(emailDeliveryErrorKind("RECIPIENT_NOT_ALLOWLISTED"), {
    kind: "recipient_not_authorized",
    retryable: false,
    code: "RECIPIENT_NOT_ALLOWLISTED",
  });
  assert.deepEqual(emailDeliveryErrorKind("RESEND_HTTP_429"), {
    kind: "provider_throttled",
    retryable: true,
    code: "RESEND_HTTP_429",
  });
  assert.deepEqual(emailDeliveryErrorKind("SOMETHING_NEW"), {
    kind: "unknown",
    retryable: false,
    code: "SOMETHING_NEW",
  });
  assert.equal(emailDeliveryErrorKind(null), null);
});

test("history page size is bounded", () => {
  assert.equal(normalizeEmailTestHistoryLimit(null), 20);
  assert.equal(normalizeEmailTestHistoryLimit("5"), 5);
  assert.equal(normalizeEmailTestHistoryLimit("999"), 50);
  assert.throws(() => normalizeEmailTestHistoryLimit("nope"), /EMAIL_TEST_HISTORY_LIMIT_INVALID/);
});
