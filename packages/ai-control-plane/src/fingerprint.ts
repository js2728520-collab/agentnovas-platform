import type { ProbeReceipt } from "./types.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export async function configurationFingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ProbeHealthState = "missing" | "pending" | "failed" | "configuration_changed" | "stale" | "healthy";

export function deriveProbeHealth(input: {
  receipt: Pick<ProbeReceipt, "configurationFingerprint" | "status" | "expiresAt"> | null;
  expectedFingerprint: string;
  now?: Date;
}): { state: ProbeHealthState; activatable: boolean } {
  if (!input.receipt) return { state: "missing", activatable: false };
  if (input.receipt.configurationFingerprint !== input.expectedFingerprint) {
    return { state: "configuration_changed", activatable: false };
  }
  if (input.receipt.status === "pending" || input.receipt.status === "running") {
    return { state: "pending", activatable: false };
  }
  if (input.receipt.status === "failed") return { state: "failed", activatable: false };
  const expiresAt = new Date(input.receipt.expiresAt);
  const now = input.now ?? new Date();
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return { state: "stale", activatable: false };
  }
  return { state: "healthy", activatable: true };
}
