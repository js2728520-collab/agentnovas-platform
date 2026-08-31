export type PaymentSecretOperation = "install" | "rotate";

export type PaymentSecretEnvelope = {
  version: "v1";
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
};

function exactObject(value: unknown, keys: string[], code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const input = value as Record<string, unknown>;
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(code);
  return input;
}

function commandObject(value: unknown, requiredKeys: string[], code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const input = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, "reason"]);
  if (requiredKeys.some(key => !(key in input)) || Object.keys(input).some(key => !allowed.has(key))) throw new Error(code);
  return input;
}

function boundedBase64Url(value: unknown, minimum: number, maximum: number, code: string) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(code);
  }
  return value;
}

export function normalizePaymentSecretEnvelope(value: unknown): PaymentSecretEnvelope {
  const input = exactObject(value, ["version", "keyId", "wrappedKey", "iv", "ciphertext"], "PAYMENT_SECRET_ENVELOPE_FIELDS_INVALID");
  if (input.version !== "v1") throw new Error("PAYMENT_SECRET_ENVELOPE_VERSION_INVALID");
  const keyId = typeof input.keyId === "string" ? input.keyId.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(keyId)) throw new Error("PAYMENT_SECRET_KEY_ID_INVALID");
  return {
    version: "v1",
    keyId,
    wrappedKey: boundedBase64Url(input.wrappedKey, 128, 768, "PAYMENT_SECRET_WRAPPED_KEY_INVALID"),
    iv: boundedBase64Url(input.iv, 16, 24, "PAYMENT_SECRET_IV_INVALID"),
    ciphertext: boundedBase64Url(input.ciphertext, 64, 24_576, "PAYMENT_SECRET_CIPHERTEXT_INVALID"),
  };
}

export function normalizePaymentSecretRequestCommand(value: unknown): {
  operation: PaymentSecretOperation;
  envelope: PaymentSecretEnvelope;
} {
  const input = commandObject(value, ["operation", "envelope"], "PAYMENT_SECRET_REQUEST_FIELDS_INVALID");
  if (input.operation !== "install" && input.operation !== "rotate") throw new Error("PAYMENT_SECRET_OPERATION_INVALID");
  return { operation: input.operation, envelope: normalizePaymentSecretEnvelope(input.envelope) };
}

type TestEvidence = {
  status: string | null;
  at: string | null;
  configurationVersion: string | null;
};

export type PaymentActivationInput = {
  secretConfigured: boolean;
  brokerAvailable: boolean;
  coinMappingConfigured: boolean;
  providerAuthorized: boolean;
  configurationVersion: string | null;
  providerTest: TestEvidence;
  callbackTest: TestEvidence;
};

const TEST_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export function paymentActivationGate(input: PaymentActivationInput, now = new Date()) {
  const blockers: string[] = [];
  if (!input.secretConfigured || !input.configurationVersion) blockers.push("PAYMENT_SECRET_CONFIGURATION_REQUIRED");
  if (!input.brokerAvailable) blockers.push("PAYMENT_SECRET_BROKER_REQUIRED");
  if (!input.coinMappingConfigured) blockers.push("COIN_MAPPING_REQUIRED");
  if (!input.providerAuthorized) blockers.push("PAYMENT_PROVIDER_AUTHORIZATION_REQUIRED");
  for (const [name, evidence] of [["PROVIDER", input.providerTest], ["CALLBACK", input.callbackTest]] as const) {
    if (evidence.status !== "passed" || !evidence.at) {
      blockers.push(`${name}_TEST_REQUIRED`);
      continue;
    }
    if (evidence.configurationVersion !== input.configurationVersion) {
      blockers.push(`${name}_TEST_CONFIGURATION_STALE`);
      continue;
    }
    const testedAt = Date.parse(evidence.at);
    if (!Number.isFinite(testedAt) || now.getTime() - testedAt > TEST_MAX_AGE_MS || testedAt > now.getTime() + 60_000) {
      blockers.push(`${name}_TEST_EXPIRED`);
    }
  }
  return { ready: blockers.length === 0, blockers };
}
