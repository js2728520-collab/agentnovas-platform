/**
 * Active session ids are expected to be ordered newest first.
 * Keep the newest maxActiveSessions - 1 existing sessions so the new login
 * can be added without exceeding the account limit.
 */
export const MAX_ACTIVE_SESSIONS = 3;

export function sessionIdsToRevoke(
  activeSessionIds: string[],
  maxActiveSessions = MAX_ACTIVE_SESSIONS,
) {
  if (!Number.isInteger(maxActiveSessions) || maxActiveSessions < 1) {
    throw new Error("maxActiveSessions must be a positive integer");
  }
  return activeSessionIds.slice(Math.max(0, maxActiveSessions - 1));
}
