export const DEPOSIT_ORDER_STATUSES = ["PENDING_CONFIRMATION", "CONFIRMING", "MANUAL_REVIEW", "CREDITED", "FAILED", "RETURNED"] as const;
export const DEPOSIT_FUNDS_STATUSES = ["NOT_CREDITED", "AVAILABLE", "PARTIALLY_FROZEN", "FROZEN", "RETURN_PENDING", "RETURNED"] as const;
export const DEPOSIT_RISK_RESULTS = ["PASS", "REVIEW", "BLOCK"] as const;
export const DEPOSIT_CHANNELS = ["on_chain", "third_party", "bank_card", "manual"] as const;
export const USDT_NETWORKS = ["TRC20", "ERC20", "BEP20"] as const;

export type DepositRiskResult = typeof DEPOSIT_RISK_RESULTS[number];

export function depositStateAfterConfirmations(input: {
  currentConfirmations: number;
  requiredConfirmations: number;
  riskResult: DepositRiskResult;
}) {
  if (input.currentConfirmations < input.requiredConfirmations) return input.currentConfirmations > 0 ? "CONFIRMING" : "PENDING_CONFIRMATION";
  if (input.riskResult === "BLOCK" || input.riskResult === "REVIEW") return "MANUAL_REVIEW";
  return "CREDITED";
}

export function csvSafeCell(value: unknown) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function isSupportedDepositNetwork(value: string): value is typeof USDT_NETWORKS[number] {
  return (USDT_NETWORKS as readonly string[]).includes(value);
}

export function isSupportedDepositChannel(value: string): value is typeof DEPOSIT_CHANNELS[number] {
  return (DEPOSIT_CHANNELS as readonly string[]).includes(value);
}

