export type FollowPolicyInput = {
  allowFollowWithoutWithdrawal: boolean;
  withdrawalAuthorized: boolean;
  publicationMode?: "marketplace" | "self_use" | string | null;
  strategyAuthorId?: string | null;
  customerId?: string | null;
};

export function evaluateFollowPolicy(input: FollowPolicyInput) {
  const isPrivateSelfUse = input.publicationMode === "self_use"
    && Boolean(input.strategyAuthorId)
    && input.strategyAuthorId === input.customerId;

  if (isPrivateSelfUse) {
    return { allowed: true, manualCollectionRequired: false, reason: "private_self_use" as const };
  }
  if (input.withdrawalAuthorized) {
    return { allowed: true, manualCollectionRequired: false, reason: "withdrawal_authorized" as const };
  }
  if (input.allowFollowWithoutWithdrawal) {
    return { allowed: true, manualCollectionRequired: true, reason: "admin_override_manual_collection" as const };
  }
  return { allowed: false, manualCollectionRequired: false, reason: "withdrawal_authorization_required" as const };
}
