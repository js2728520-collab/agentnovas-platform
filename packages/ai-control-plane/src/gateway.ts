import { isRetryableProviderFailure } from "./bindings.ts";
import type {
  AiRoleKey,
  BindingCandidate,
  InvocationReceipt,
  ProviderFailure,
  TokenUsage,
  UsageEvent,
} from "./types.ts";

export type GatewayInvocationInput = {
  invocationId: string;
  requestHash: string;
  roleKey: AiRoleKey;
  operation: string;
  trafficKind: UsageEvent["trafficKind"];
  payload: unknown;
  signal?: AbortSignal;
};

export type GatewayInvocationResult = { content: string; receipt: InvocationReceipt };

export interface IdempotentInvocationRepository {
  begin(input: GatewayInvocationInput): Promise<
    | { kind: "claimed" }
    | { kind: "replay"; result: GatewayInvocationResult }
    | { kind: "conflict" }
    | { kind: "in_progress" }
  >;
  complete(result: GatewayInvocationResult): Promise<void>;
}

type OrchestratorOptions = {
  repository: IdempotentInvocationRepository;
  resolveCandidates(roleKey: AiRoleKey): Promise<readonly BindingCandidate[]>;
  invokeCandidate(input: {
    candidate: BindingCandidate;
    payload: unknown;
    signal?: AbortSignal;
  }): Promise<{ content: string; usage: TokenUsage }>;
  usageSink: { append(event: UsageEvent): Promise<void> };
  now?: () => Date;
};

class GatewayError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

const providerFailureCodes = new Set<ProviderFailure["code"]>([
  "network", "timeout", "rate_limited", "provider_5xx", "authentication", "configuration",
  "validation", "budget", "permission", "cancelled", "output_contract",
]);

function failureFrom(error: unknown): ProviderFailure {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "network";
  return {
    code: providerFailureCodes.has(code as ProviderFailure["code"])
      ? code as ProviderFailure["code"]
      : "network",
  };
}

function assertInvocationInput(input: GatewayInvocationInput) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.invocationId)) {
    throw new GatewayError("AI_INVOCATION_ID_INVALID", "Invocation ID is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new GatewayError("AI_INVOCATION_HASH_INVALID", "Request hash is invalid");
  }
}

function publicSelection(candidate: BindingCandidate): Omit<BindingCandidate, "secretRef"> {
  return {
    fallbackRank: candidate.fallbackRank,
    policyRevisionId: candidate.policyRevisionId,
    deploymentId: candidate.deploymentId,
    deploymentRevisionId: candidate.deploymentRevisionId,
    connectionId: candidate.connectionId,
    connectionRevisionId: candidate.connectionRevisionId,
  };
}

export function createInvocationOrchestrator(options: OrchestratorOptions) {
  const now = options.now ?? (() => new Date());
  async function event(input: GatewayInvocationInput, values: Partial<UsageEvent> & Pick<UsageEvent, "status">) {
    await options.usageSink.append({
      id: crypto.randomUUID(),
      invocationId: input.invocationId,
      roleKey: input.roleKey,
      operation: input.operation,
      trafficKind: input.trafficKind,
      status: values.status,
      fallbackRank: values.fallbackRank ?? null,
      deploymentRevisionId: values.deploymentRevisionId ?? null,
      connectionRevisionId: values.connectionRevisionId ?? null,
      usage: values.usage ?? null,
      queueLatencyMs: values.queueLatencyMs ?? null,
      providerLatencyMs: values.providerLatencyMs ?? null,
      totalLatencyMs: values.totalLatencyMs ?? null,
      providerCost: values.providerCost ?? null,
      settledCredits: values.settledCredits ?? null,
      pricingState: values.pricingState ?? "unpriced",
      createdAt: now().toISOString(),
      ...(values.errorCode ? { errorCode: values.errorCode } : {}),
    });
  }

  return {
    async invoke(input: GatewayInvocationInput): Promise<GatewayInvocationResult> {
      assertInvocationInput(input);
      const claim = await options.repository.begin(input);
      if (claim.kind === "replay") return claim.result;
      if (claim.kind === "conflict") {
        throw new GatewayError("AI_INVOCATION_IDEMPOTENCY_CONFLICT", "Invocation ID belongs to a different request");
      }
      if (claim.kind === "in_progress") {
        throw new GatewayError("AI_INVOCATION_IN_PROGRESS", "Invocation is still processing");
      }

      await event(input, { status: "requested" });
      const candidates = [...await options.resolveCandidates(input.roleKey)]
        .sort((left,right) => left.fallbackRank - right.fallbackRank);
      let finalFailure: ProviderFailure = { code: "configuration" };
      let attempts = 0;
      for (const candidate of candidates.slice(0, 3)) {
        attempts += 1;
        if (input.signal?.aborted) finalFailure = { code: "cancelled" };
        if (input.signal?.aborted) break;
        await event(input, {
          status: "attempted",
          fallbackRank: candidate.fallbackRank,
          deploymentRevisionId: candidate.deploymentRevisionId,
          connectionRevisionId: candidate.connectionRevisionId,
        });
        const startedAt = now().getTime();
        try {
          const response = await options.invokeCandidate({ candidate,payload: input.payload,signal: input.signal });
          const providerLatencyMs = Math.max(0,now().getTime() - startedAt);
          const receipt: InvocationReceipt = {
            invocationId: input.invocationId,
            requestHash: input.requestHash,
            status: "succeeded",
            selectedCandidate: publicSelection(candidate),
            attemptCount: attempts,
            usage: response.usage,
          };
          const result = { content: response.content,receipt };
          await options.repository.complete(result);
          await event(input, {
            status: "succeeded",
            fallbackRank: candidate.fallbackRank,
            deploymentRevisionId: candidate.deploymentRevisionId,
            connectionRevisionId: candidate.connectionRevisionId,
            usage: response.usage,
            providerLatencyMs,
            totalLatencyMs: providerLatencyMs,
          });
          return result;
        } catch (error) {
          finalFailure = failureFrom(error);
          await event(input, {
            status: finalFailure.code === "cancelled" ? "cancelled" : "failed",
            fallbackRank: candidate.fallbackRank,
            deploymentRevisionId: candidate.deploymentRevisionId,
            connectionRevisionId: candidate.connectionRevisionId,
            providerLatencyMs: Math.max(0,now().getTime() - startedAt),
            errorCode: finalFailure.code,
          });
          if (!isRetryableProviderFailure(finalFailure)) break;
        }
      }
      const receipt: InvocationReceipt = {
        invocationId: input.invocationId,
        requestHash: input.requestHash,
        status: finalFailure.code === "cancelled" ? "cancelled" : "failed",
        selectedCandidate: null,
        attemptCount: attempts,
        usage: null,
        errorCode: finalFailure.code,
      };
      const result = { content: "",receipt };
      await options.repository.complete(result);
      return result;
    },
  };
}
