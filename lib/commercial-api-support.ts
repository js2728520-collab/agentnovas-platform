import { createHash } from "node:crypto";

export type CommercialCursor = { createdAt: string; id: string };

export const PAYMENT_REFERENCE_FINGERPRINT_VERSION = "nfkc-upper-v2" as const;

export function encodeCommercialCursor(cursor: CommercialCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCommercialCursor(value: string | null): CommercialCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CommercialCursor>;
    if (!parsed.createdAt || !parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error("COMMERCIAL_CURSOR_INVALID");
  }
}

export function maskPaymentReference(value: string) {
  const normalized = normalizePaymentReference(value);
  return normalized.length <= 4 ? "****" : `********${normalized.slice(-4)}`;
}

export function normalizePaymentReference(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
}

export function fingerprintPaymentReference(value: string) {
  return createHash("sha256")
    .update(normalizePaymentReference(value), "utf8")
    .digest("hex");
}

export function previousCompleteUtcWeek(now = new Date()) {
  const currentMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (currentMonday.getUTCDay() + 6) % 7;
  currentMonday.setUTCDate(currentMonday.getUTCDate() - daysSinceMonday);
  const weekEnd = currentMonday;
  const weekStart = new Date(weekEnd);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  return { weekStart: weekStart.toISOString(), weekEnd: weekEnd.toISOString() };
}
