export type AiConsumer = "research" | "runtime" | "client";

export type AiRoleKey =
  | "research.requirements"
  | "research.market_regime"
  | "research.proposal_a"
  | "research.proposal_b"
  | "research.adversarial_review"
  | "research.risk_review"
  | "research.report"
  | "runtime.market_summary"
  | "runtime.adversarial_explanation"
  | "runtime.risk_explanation"
  | "client.assistant_message"
  | "client.strategy_generation";

export type ConsumerRuntimeState = "active" | "gated" | "disabled" | "retired";

export type RoleDescriptor = {
  key: AiRoleKey;
  consumer: AiConsumer;
  role: string;
  label: string;
  runtimeState: ConsumerRuntimeState;
  requirement: CapabilityRequirement;
};

export type ModelCapability = {
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
};

export type CapabilityRequirement = {
  inputModalities?: readonly string[];
  outputModalities?: readonly string[];
  minimumContextWindowTokens?: number;
  minimumMaxOutputTokens?: number;
  requiresStreaming?: boolean;
  requiresStructuredOutput?: boolean;
};

export type ProviderConnection = {
  id: string;
  name: string;
  adapterId: string;
  enabled: boolean;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  hasSecret?: boolean;
};

export type ConnectionRevision = {
  id: string;
  connectionId: string;
  revisionNumber?: number;
  adapterId?: string;
  endpoint?: string;
  secretRef: string;
  secretVersion?: string;
  configurationFingerprint?: string;
  enabled: boolean;
  createdAt?: string;
};

export type ModelDeployment = {
  id: string;
  name?: string;
  connectionId: string;
  enabled: boolean;
  currentRevisionId: string | null;
  createdAt?: string;
  updatedAt?: string;
  modelId?: string;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  supportsStreaming?: boolean;
  supportsStructuredOutput?: boolean;
  rateCard?: RateCardRevision | null;
};

export type DeploymentRevision = {
  id: string;
  deploymentId: string;
  revisionNumber: number;
  modelId: string;
  capability: ModelCapability;
  defaultMaxOutputTokens: number;
  defaultTimeoutMs: number;
  enabled: boolean;
  createdAt: string;
  connectionId?: string;
  deploymentName?: string;
  connectionName?: string;
  isCurrent?: boolean;
  hasSecret?: boolean;
  rateCard?: RateCardRevision | null;
};

export type BindingTarget = {
  deploymentId: string;
  deploymentRevisionId?: string;
  priority: number;
};

export type BindingPolicy = {
  id: string;
  roleKey: AiRoleKey;
  revisionId: string;
  enabled: boolean;
  targets: readonly BindingTarget[];
  runtimeState?: ConsumerRuntimeState;
};

export type ProbeReceipt = {
  id: string;
  configurationFingerprint: string;
  phase?: "endpoint" | "authentication" | "model_discovery" | "invocation";
  status: "pending" | "running" | "succeeded" | "failed";
  testedAt: string;
  expiresAt: string;
  isExpired?: boolean;
  latencyMs?: number;
  errorCode?: string | null;
  models?: readonly string[] | null;
  deploymentRevisionId?: string | null;
};

export type ProviderFailureCode =
  | "network"
  | "timeout"
  | "rate_limited"
  | "provider_5xx"
  | "authentication"
  | "configuration"
  | "validation"
  | "budget"
  | "permission"
  | "cancelled"
  | "output_contract";

export type ProviderFailure = {
  code: ProviderFailureCode;
  status?: number;
  safeMessage?: string;
};

export type BindingCandidate = {
  fallbackRank: number;
  policyRevisionId: string;
  deploymentId: string;
  deploymentRevisionId: string;
  connectionId: string;
  connectionRevisionId: string;
  secretRef: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

export type InvocationReceipt = {
  invocationId: string;
  requestHash: string;
  status: "succeeded" | "failed" | "cancelled";
  selectedCandidate: Omit<BindingCandidate, "secretRef"> | null;
  attemptCount: number;
  usage: TokenUsage | null;
  providerRequestId?: string;
  fallbackTrace?: readonly {
    fallbackRank: number;
    deploymentRevisionId: string;
    connectionRevisionId: string;
    status: "succeeded" | "failed" | "cancelled";
    errorCode?: ProviderFailureCode;
  }[];
  errorCode?: ProviderFailureCode;
};

export type UsageEvent = {
  id: string;
  invocationId: string;
  roleKey: AiRoleKey;
  operation: string;
  trafficKind: "business" | "probe";
  status: "requested" | "attempted" | "processing" | "succeeded" | "failed" | "cancelled";
  fallbackRank: number | null;
  deploymentRevisionId: string | null;
  connectionRevisionId: string | null;
  usage: TokenUsage | null;
  queueLatencyMs: number | null;
  providerLatencyMs: number | null;
  totalLatencyMs: number | null;
  providerCost: { currency: string; amount: string } | null;
  settledCredits: string | null;
  pricingState: "priced" | "unpriced";
  errorCode?: string;
  createdAt: string;
};

export type UsageMetricSummary = {
  requestCount: number;
  attemptedCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  fallbackAttemptCount: number;
  inputTokens: string;
  outputTokens: string;
  cachedInputTokens: string;
  reasoningTokens: string;
  unpricedCount: number;
  providerLatencyP50Ms: number | null;
  providerLatencyP95Ms: number | null;
  queueLatencyP50Ms?: number | null;
  queueLatencyP95Ms?: number | null;
  totalLatencyP50Ms?: number | null;
  totalLatencyP95Ms?: number | null;
};

export type UsageBreakdown = UsageMetricSummary & { key: string; label?: string };

export type UsageSnapshot = {
  from: string;
  to: string;
  timezone: string;
  includesProbeTraffic: boolean;
  summary: UsageMetricSummary;
  byConsumer: readonly UsageBreakdown[];
  byRole: readonly UsageBreakdown[];
  byDeployment: readonly UsageBreakdown[];
  providerCosts: readonly { currency: string; amount: string }[];
  settledCredits: string;
};

export type RateCardRevision = {
  id: string;
  deploymentId: string;
  currency: string;
  inputPerMillion: string;
  outputPerMillion: string;
  cachedInputPerMillion?: string | null;
  effectiveAt: string;
};

export type BudgetPolicy = {
  id: string;
  scope: "platform" | "organization" | "consumer" | "role" | "deployment";
  scopeId: string;
  unit: "requests" | "tokens" | "provider_cost" | "platform_credits";
  limit: string;
  warningPercentage: number;
  enabled: boolean;
  period?: "day" | "month";
};
