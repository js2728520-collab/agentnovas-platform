export type EmailDeliveryStatus = "queued" | "sent" | "delivered" | "failed";
export type EmailServiceEffectiveStatus = "unconfigured" | "disabled" | "ready" | "degraded";
export type EmailConfigurationAction = "activate" | "disable";
export type EmailTestRecipientStatus = "pending_verification" | "active" | "disabled" | "deleted";
export type EmailRecipientAction = "enable" | "disable";
export type EmailRecipientVerificationAction = "verify" | "resend";
export type EmailSecretOperation = "install" | "rotate";

export type EmailSecretEnvelope = {
  version: "v1";
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
};

export type EmailTestRecipient = {
  id: string;
  label: string;
  address: string;
  mask: string;
  status: EmailTestRecipientStatus;
  suppressed: boolean;
  verificationSentAt: string | null;
  verificationExpiresAt: string | null;
  verifiedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type EmailServiceGateSnapshot = {
  apiKeyPresent: boolean;
  webhookSecretPresent: boolean;
  senderDomainVerified: boolean;
  templatesReady: boolean;
  suppressionReady: boolean;
  workerEnabled: boolean;
  environmentSendEnabled: boolean;
  providerAuthorized: boolean;
};

export type EmailTestRecord = {
  id: string;
  recipient: string;
  recipientVisibility: "full" | "masked";
  status: EmailDeliveryStatus;
  queuedAt: string;
  sentAt: string | null;
  providerEventAt: string | null;
  providerEventType: string | null;
  providerMessageReference: string | null;
  lastErrorCode: string | null;
};

const CONFIGURATION_ACTIONS = new Set<EmailConfigurationAction>([
  "activate",
  "disable",
]);

const RECIPIENT_ACTIONS = new Set<EmailRecipientAction>(["enable", "disable"]);
const RECIPIENT_VERIFICATION_ACTIONS = new Set<EmailRecipientVerificationAction>(["verify", "resend"]);
const EMAIL_SECRET_OPERATIONS = new Set<EmailSecretOperation>(["install", "rotate"]);

const REQUIRED_CONFIGURATION_GATES: Array<keyof EmailServiceGateSnapshot> = [
  "apiKeyPresent",
  "webhookSecretPresent",
  "senderDomainVerified",
  "templatesReady",
  "suppressionReady",
];

export function deriveEmailServiceEffectiveStatus(input: {
  gates: EmailServiceGateSnapshot;
  latestTestStatus: EmailDeliveryStatus | null;
}): EmailServiceEffectiveStatus {
  if (REQUIRED_CONFIGURATION_GATES.some(gate => !input.gates[gate])) return "unconfigured";
  if (!input.gates.providerAuthorized || !input.gates.environmentSendEnabled) return "disabled";
  if (!input.gates.workerEnabled || input.latestTestStatus === "failed") return "degraded";
  return "ready";
}

export function normalizeEmailConfigurationCommand(value: unknown): {
  action: EmailConfigurationAction;
  reason: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EMAIL_CONFIGURATION_FIELDS_INVALID");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "reason") {
    throw new Error("EMAIL_CONFIGURATION_FIELDS_INVALID");
  }
  if (typeof input.action !== "string" || !CONFIGURATION_ACTIONS.has(input.action as EmailConfigurationAction)) {
    throw new Error("EMAIL_CONFIGURATION_ACTION_INVALID");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) throw new Error("EMAIL_CONFIGURATION_REASON_INVALID");
  return { action: input.action as EmailConfigurationAction, reason };
}

function exactObject(value: unknown, keys: string[], code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const input = value as Record<string, unknown>;
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(code);
  return input;
}

function auditReason(value: unknown, code: string) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < 3 || reason.length > 500) throw new Error(code);
  return reason;
}

function normalizedEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("EMAIL_RECIPIENT_ADDRESS_INVALID");
  }
  return email;
}

export function normalizeEmailRecipientCreateCommand(value: unknown) {
  const input = exactObject(value, ["email", "label", "reason"], "EMAIL_RECIPIENT_FIELDS_INVALID");
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length < 1 || label.length > 80) throw new Error("EMAIL_RECIPIENT_LABEL_INVALID");
  return {
    email: normalizedEmail(input.email),
    label,
    reason: auditReason(input.reason, "EMAIL_RECIPIENT_REASON_INVALID"),
  };
}

export function normalizeEmailRecipientVerificationCommand(value: unknown):
  | { action: "verify"; code: string; reason: string }
  | { action: "resend"; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EMAIL_RECIPIENT_VERIFICATION_FIELDS_INVALID");
  const raw = value as Record<string, unknown>;
  if (typeof raw.action !== "string" || !RECIPIENT_VERIFICATION_ACTIONS.has(raw.action as EmailRecipientVerificationAction)) {
    throw new Error("EMAIL_RECIPIENT_VERIFICATION_ACTION_INVALID");
  }
  if (raw.action === "verify") {
    const input = exactObject(value, ["action", "code", "reason"], "EMAIL_RECIPIENT_VERIFICATION_FIELDS_INVALID");
    if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code)) throw new Error("EMAIL_RECIPIENT_CODE_INVALID");
    return {
      action: "verify",
      code: input.code,
      reason: auditReason(input.reason, "EMAIL_RECIPIENT_REASON_INVALID"),
    };
  }
  const input = exactObject(value, ["action", "reason"], "EMAIL_RECIPIENT_VERIFICATION_FIELDS_INVALID");
  return {
    action: "resend",
    reason: auditReason(input.reason, "EMAIL_RECIPIENT_REASON_INVALID"),
  };
}

export function normalizeEmailRecipientCommand(value: unknown): { action: EmailRecipientAction; reason: string } {
  const input = exactObject(value, ["action", "reason"], "EMAIL_RECIPIENT_FIELDS_INVALID");
  if (typeof input.action !== "string" || !RECIPIENT_ACTIONS.has(input.action as EmailRecipientAction)) {
    throw new Error("EMAIL_RECIPIENT_ACTION_INVALID");
  }
  return {
    action: input.action as EmailRecipientAction,
    reason: auditReason(input.reason, "EMAIL_RECIPIENT_REASON_INVALID"),
  };
}

export function normalizeEmailTestCommand(value: unknown): { recipientId: string; reason: string } {
  const input = exactObject(value, ["recipientId", "reason"], "EMAIL_TEST_FIELDS_INVALID");
  const recipientId = typeof input.recipientId === "string" ? input.recipientId.trim() : "";
  if (!/^[A-Za-z0-9-]{8,80}$/.test(recipientId)) throw new Error("EMAIL_TEST_RECIPIENT_ID_INVALID");
  return { recipientId, reason: auditReason(input.reason, "EMAIL_TEST_REASON_INVALID") };
}

function boundedBase64Url(value: unknown, minimum: number, maximum: number, code: string) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(code);
  }
  return value;
}

export function normalizeEmailSecretEnvelope(value: unknown): EmailSecretEnvelope {
  const input = exactObject(value, ["version", "keyId", "wrappedKey", "iv", "ciphertext"], "EMAIL_SECRET_ENVELOPE_FIELDS_INVALID");
  if (input.version !== "v1") throw new Error("EMAIL_SECRET_ENVELOPE_VERSION_INVALID");
  const keyId = typeof input.keyId === "string" ? input.keyId.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(keyId)) throw new Error("EMAIL_SECRET_KEY_ID_INVALID");
  return {
    version: "v1",
    keyId,
    wrappedKey: boundedBase64Url(input.wrappedKey, 128, 768, "EMAIL_SECRET_WRAPPED_KEY_INVALID"),
    iv: boundedBase64Url(input.iv, 16, 24, "EMAIL_SECRET_IV_INVALID"),
    ciphertext: boundedBase64Url(input.ciphertext, 32, 16_384, "EMAIL_SECRET_CIPHERTEXT_INVALID"),
  };
}

export function normalizeEmailSecretRequestCommand(value: unknown): {
  operation: EmailSecretOperation;
  envelope: EmailSecretEnvelope;
  reason: string;
} {
  const input = exactObject(value, ["operation", "envelope", "reason"], "EMAIL_SECRET_REQUEST_FIELDS_INVALID");
  if (typeof input.operation !== "string" || !EMAIL_SECRET_OPERATIONS.has(input.operation as EmailSecretOperation)) {
    throw new Error("EMAIL_SECRET_OPERATION_INVALID");
  }
  return {
    operation: input.operation as EmailSecretOperation,
    envelope: normalizeEmailSecretEnvelope(input.envelope),
    reason: auditReason(input.reason, "EMAIL_SECRET_REASON_INVALID"),
  };
}

export function maskEmailAddress(value: string) {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
  if (!match) return "••••••••";
  const [, local, domain] = match;
  if (local.length <= 2) return `${local}@${domain}`;
  return `${local[0]}${"•".repeat(Math.min(6, local.length - 2))}${local.at(-1)}@${domain}`;
}

export type EmailDeliveryErrorKind =
  | "recipient_not_authorized"
  | "recipient_suppressed"
  | "invalid_recipient"
  | "provider_throttled"
  | "provider_rejected"
  | "provider_unreachable"
  | "unknown";

export function emailDeliveryErrorKind(code: string | null): {
  kind: EmailDeliveryErrorKind;
  retryable: boolean;
  code: string;
} | null {
  if (!code) return null;
  if (code === "RECIPIENT_NOT_ALLOWLISTED") return { kind: "recipient_not_authorized", retryable: false, code };
  if (code === "TEST_RECIPIENT_NOT_AUTHORIZED" || code === "TEST_RECIPIENT_NOT_PENDING" || code === "INVALID_RECIPIENT_BINDING") return { kind: "recipient_not_authorized", retryable: false, code };
  if (code === "RECIPIENT_SUPPRESSED" || code === "RESEND_EMAIL_SUPPRESSED") return { kind: "recipient_suppressed", retryable: false, code };
  if (code === "INVALID_RECIPIENT") return { kind: "invalid_recipient", retryable: false, code };
  if (code === "RESEND_HTTP_429") return { kind: "provider_throttled", retryable: true, code };
  if (code === "RESEND_NETWORK_ERROR" || code === "RESEND_INVALID_RESPONSE") return { kind: "provider_unreachable", retryable: true, code };
  if (/^RESEND_HTTP_(?:408|409|425|5\d\d)$/.test(code)) return { kind: "provider_unreachable", retryable: true, code };
  if (code.startsWith("RESEND_")) return { kind: "provider_rejected", retryable: false, code };
  return { kind: "unknown", retryable: false, code };
}

export function normalizeEmailTestHistoryLimit(value: string | null) {
  if (value === null || value === "") return 20;
  if (!/^\d+$/.test(value)) throw new Error("EMAIL_TEST_HISTORY_LIMIT_INVALID");
  return Math.min(50, Math.max(1, Number(value)));
}

export function providerMessageReference(value: string | null) {
  if (!value) return null;
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
