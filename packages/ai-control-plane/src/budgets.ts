function exactNonNegativeInteger(value: string, label: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}

export function evaluateSoftBudget(input: { limit: string; used: string }) {
  const limit = exactNonNegativeInteger(input.limit, "budget limit");
  const used = exactNonNegativeInteger(input.used, "budget usage");
  if (limit === BigInt(0)) throw new Error("budget limit must be greater than zero");
  const percentage = Number((used * BigInt(1_000)) / limit) / 10;
  const state = percentage >= 100 ? "exceeded" : percentage >= 80 ? "warning" : "normal";
  return { state, percentage, shouldBlock: false } as const;
}
