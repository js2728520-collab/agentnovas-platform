import type { AppAudience } from "./riverton-apps.ts";

export type SessionMfaLevel = "none" | "primary" | "totp" | "recovery";

type SessionAssuranceInput = {
  audience: AppAudience;
  idleExpiresAt: string | null;
  absoluteExpiresAt: string | null;
  mfaLevel: SessionMfaLevel;
  mfaVerifiedAt: string | null;
};

export function evaluateSessionAssurance(
  input: SessionAssuranceInput,
  now = new Date(),
  options: { allowPrimaryInternal?: boolean; mfaEnforced?: boolean; recentMfaSeconds?: number } = {},
) {
  const nowMs = now.getTime();
  const withinBounds = Boolean(
    input.idleExpiresAt
      && input.absoluteExpiresAt
      && Date.parse(input.idleExpiresAt) > nowMs
      && Date.parse(input.absoluteExpiresAt) > nowMs,
  );
  const internal = input.audience !== "client";
  const completedMfa = input.mfaLevel === "totp" || input.mfaLevel === "recovery";
  const mfaEnforced = options.mfaEnforced ?? true;
  const usable = withinBounds && Boolean(
    !internal || !mfaEnforced || completedMfa || (options.allowPrimaryInternal && input.mfaLevel === "primary"),
  );
  const recentMfaSeconds = options.recentMfaSeconds ?? 15 * 60;
  const verifiedAt = input.mfaVerifiedAt ? Date.parse(input.mfaVerifiedAt) : Number.NaN;
  const recentMfa = completedMfa
    && Number.isFinite(verifiedAt)
    && verifiedAt <= nowMs + 60_000
    && verifiedAt >= nowMs - recentMfaSeconds * 1000;
  return { usable, recentMfa: usable && recentMfa };
}
