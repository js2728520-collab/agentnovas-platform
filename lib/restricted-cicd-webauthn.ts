import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/;

export type RestrictedCicdWebAuthnCredential = {
  credentialId: string;
  userId: string;
  algorithm: "ES256" | "Ed25519";
  publicKeyPem: string;
};

export type RestrictedCicdWebAuthnPolicy = {
  schemaVersion: "1";
  rpId: string;
  allowedOrigins: string[];
  credentials: RestrictedCicdWebAuthnCredential[];
};

export type RestrictedCicdWebAuthnAssertion = {
  challengeId: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle?: string;
};

function exactObject(value: unknown, keys: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    throw new Error(`${label} invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${label} invalid`);
  return value;
}

function decodeBase64url(value: string, maximumBytes: number, label: string) {
  if (!value || value.length > Math.ceil(maximumBytes * 4 / 3) + 4 || !BASE64URL.test(value)) throw new Error(`${label} invalid`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length < 1 || decoded.length > maximumBytes || decoded.toString("base64url") !== value) throw new Error(`${label} invalid`);
  return decoded;
}

export function parseRestrictedCicdWebAuthnPolicy(value: unknown): RestrictedCicdWebAuthnPolicy {
  const object = exactObject(value, ["schemaVersion", "rpId", "allowedOrigins", "credentials"], "WebAuthn policy");
  if (object.schemaVersion !== "1") throw new Error("WebAuthn policy invalid");
  const rpId = boundedString(object.rpId, 3, 253, "WebAuthn RP ID").toLowerCase();
  if (!/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(rpId)) {
    throw new Error("WebAuthn RP ID invalid");
  }
  if (!Array.isArray(object.allowedOrigins) || object.allowedOrigins.length < 1 || object.allowedOrigins.length > 10) {
    throw new Error("WebAuthn origins invalid");
  }
  const allowedOrigins = object.allowedOrigins.map((origin) => {
    const parsed = new URL(boundedString(origin, 10, 300, "WebAuthn origin"));
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.hostname !== rpId) throw new Error("WebAuthn origin invalid");
    return origin;
  });
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new Error("WebAuthn origins invalid");
  if (!Array.isArray(object.credentials) || object.credentials.length < 1 || object.credentials.length > 100) {
    throw new Error("WebAuthn credentials invalid");
  }
  const credentials = object.credentials.map((input) => {
    const credential = exactObject(input, ["credentialId", "userId", "algorithm", "publicKeyPem"], "WebAuthn credential");
    const credentialId = boundedString(credential.credentialId, 16, 1024, "WebAuthn credential ID");
    decodeBase64url(credentialId, 768, "WebAuthn credential ID");
    const userId = boundedString(credential.userId, 3, 160, "WebAuthn user ID");
    if (!IDENTIFIER.test(userId)) throw new Error("WebAuthn user ID invalid");
    if (credential.algorithm !== "ES256" && credential.algorithm !== "Ed25519") throw new Error("WebAuthn algorithm invalid");
    const algorithm: RestrictedCicdWebAuthnCredential["algorithm"] = credential.algorithm;
    const publicKeyPem = boundedString(credential.publicKeyPem, 80, 4096, "WebAuthn public key");
    const key = createPublicKey(publicKeyPem);
    if ((algorithm === "ES256" && key.asymmetricKeyType !== "ec")
      || (algorithm === "Ed25519" && key.asymmetricKeyType !== "ed25519")) {
      throw new Error("WebAuthn public key algorithm mismatch");
    }
    return { credentialId, userId, algorithm, publicKeyPem };
  });
  if (new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length) {
    throw new Error("WebAuthn credential IDs must be unique");
  }
  return { schemaVersion: "1", rpId, allowedOrigins, credentials };
}

export function parseRestrictedCicdWebAuthnAssertion(value: unknown): RestrictedCicdWebAuthnAssertion {
  const object = exactObject(value, value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "userHandle")
    ? ["challengeId", "credentialId", "clientDataJSON", "authenticatorData", "signature", "userHandle"]
    : ["challengeId", "credentialId", "clientDataJSON", "authenticatorData", "signature"], "WebAuthn assertion");
  const assertion = {
    challengeId: boundedString(object.challengeId, 3, 160, "WebAuthn challenge ID"),
    credentialId: boundedString(object.credentialId, 16, 1024, "WebAuthn credential ID"),
    clientDataJSON: boundedString(object.clientDataJSON, 8, 8192, "WebAuthn client data"),
    authenticatorData: boundedString(object.authenticatorData, 8, 8192, "WebAuthn authenticator data"),
    signature: boundedString(object.signature, 8, 8192, "WebAuthn signature"),
    userHandle: object.userHandle === undefined ? undefined : boundedString(object.userHandle, 1, 1024, "WebAuthn user handle"),
  };
  if (!IDENTIFIER.test(assertion.challengeId)) throw new Error("WebAuthn challenge ID invalid");
  decodeBase64url(assertion.credentialId, 768, "WebAuthn credential ID");
  decodeBase64url(assertion.clientDataJSON, 6144, "WebAuthn client data");
  decodeBase64url(assertion.authenticatorData, 6144, "WebAuthn authenticator data");
  decodeBase64url(assertion.signature, 6144, "WebAuthn signature");
  if (assertion.userHandle) decodeBase64url(assertion.userHandle, 768, "WebAuthn user handle");
  return assertion;
}

export function verifyRestrictedCicdWebAuthnAssertion(input: {
  policy: RestrictedCicdWebAuthnPolicy;
  assertion: RestrictedCicdWebAuthnAssertion;
  expectedChallenge: string;
  expectedUserId: string;
  previousSignCount?: number;
}) {
  const credential = input.policy.credentials.find((candidate) => candidate.credentialId === input.assertion.credentialId);
  if (!credential || credential.userId !== input.expectedUserId) throw new Error("WebAuthn credential unavailable");
  const clientDataBytes = decodeBase64url(input.assertion.clientDataJSON, 6144, "WebAuthn client data");
  let clientData: Record<string, unknown>;
  try { clientData = JSON.parse(clientDataBytes.toString("utf8")); }
  catch { throw new Error("WebAuthn client data invalid"); }
  if (clientData.type !== "webauthn.get" || clientData.challenge !== input.expectedChallenge
    || typeof clientData.origin !== "string" || !input.policy.allowedOrigins.includes(clientData.origin)
    || clientData.crossOrigin === true || clientData.topOrigin !== undefined) {
    throw new Error("WebAuthn client binding invalid");
  }
  const authenticatorData = decodeBase64url(input.assertion.authenticatorData, 6144, "WebAuthn authenticator data");
  if (authenticatorData.length < 37) throw new Error("WebAuthn authenticator data invalid");
  const expectedRpIdHash = createHash("sha256").update(input.policy.rpId).digest();
  if (!timingSafeEqual(authenticatorData.subarray(0, 32), expectedRpIdHash)) throw new Error("WebAuthn RP binding invalid");
  const flags = authenticatorData[32] ?? 0;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0 || ((flags & 0x10) !== 0 && (flags & 0x08) === 0)) {
    throw new Error("WebAuthn user verification required");
  }
  const signCount = authenticatorData.readUInt32BE(33);
  if ((input.previousSignCount ?? 0) > 0 && signCount > 0 && signCount <= (input.previousSignCount ?? 0)) {
    throw new Error("WebAuthn sign counter replayed");
  }
  const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataBytes).digest()]);
  const signature = decodeBase64url(input.assertion.signature, 6144, "WebAuthn signature");
  const valid = credential.algorithm === "ES256"
    ? verify("sha256", signed, { key: credential.publicKeyPem, dsaEncoding: "der" }, signature)
    : verify(null, signed, credential.publicKeyPem, signature);
  if (!valid) throw new Error("WebAuthn signature invalid");
  return { credential, signCount, origin: clientData.origin };
}

export function restrictedCicdWebAuthnAssertionSha256(assertion: RestrictedCicdWebAuthnAssertion) {
  return createHash("sha256").update(JSON.stringify(assertion)).digest("hex");
}
