import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type VerifiedResendWebhook = {
  eventId: string;
  timestamp: number;
};

function decodeBase64(value: string) {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
  const bytes = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/, "");
  const normalizedOutput = bytes.toString("base64").replace(/=+$/, "");
  return normalizedInput === normalizedOutput ? bytes : null;
}

function webhookSecretBytes(secret: string) {
  if (!secret.startsWith("whsec_")) return Buffer.from(secret, "utf8");
  const bytes = decodeBase64(secret.slice("whsec_".length));
  if (!bytes?.length) throw new Error("WEBHOOK_SECRET_INVALID");
  return bytes;
}

function signatureCandidates(header: string) {
  return header
    .trim()
    .split(/\s+/)
    .map((entry) => entry.split(",", 2))
    .filter(([version, signature]) => version === "v1" && Boolean(signature))
    .map(([, signature]) => signature);
}

export function verifyResendWebhook(input: {
  body: string;
  eventId: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): VerifiedResendWebhook {
  const eventId = input.eventId?.trim();
  const timestampText = input.timestamp?.trim();
  const signature = input.signature?.trim();
  if (!eventId || !timestampText || !signature) throw new Error("WEBHOOK_SIGNATURE_REQUIRED");

  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) throw new Error("WEBHOOK_TIMESTAMP_INVALID");
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) throw new Error("WEBHOOK_TIMESTAMP_EXPIRED");

  const expected = createHmac("sha256", webhookSecretBytes(input.secret))
    .update(`${eventId}.${timestampText}.${input.body}`, "utf8")
    .digest();
  const valid = signatureCandidates(signature).some((candidate) => {
    const supplied = decodeBase64(candidate);
    return supplied?.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!valid) throw new Error("WEBHOOK_SIGNATURE_INVALID");
  return { eventId, timestamp };
}
