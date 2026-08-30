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
};

export type BindingTarget = {
  deploymentId: string;
  priority: number;
};

export type BindingPolicy = {
  id: string;
  roleKey: AiRoleKey;
  revisionId: string;
  enabled: boolean;
  targets: readonly BindingTarget[];
};

export type ProbeReceipt = {
  id: string;
  configurationFingerprint: string;
  status: "pending" | "running" | "succeeded" | "failed";
  testedAt: string;
  expiresAt: string;
  latencyMs?: number;
  errorCode?: string | null;
  models?: readonly string[] | null;
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
  selectedCandidate: BindingCandidate | null;
  attemptCount: number;
  usage: TokenUsage | null;
  providerRequestId?: string;
  errorCode?: ProviderFailureCode;
};

export type UsageEvent = {
  id: string;
  invocationId: string;
  roleKey: AiRoleKey;
  operation: string;
  trafficKind: "business" | "probe";
  status: "processing" | "succeeded" | "failed" | "cancelled";
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
  createdAt: string;
};

export type RateCardRevision = {
  id: string;
  deploymentId: string;
  currency: string;
  inputPerMillion: string;
  outputPerMillion: string;
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
};
