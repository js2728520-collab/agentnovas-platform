import {
  configurationFingerprint,
  createInvocationOrchestrator,
  type GatewayInvocationInput,
  type ProviderAdapter,
} from "@agentnovas/ai-control-plane";
import type { Pool } from "pg";

import {
  createPostgresInvocationRepository,
  createPostgresUsageSink,
  claimPostgresProbe,
  completePostgresProbe,
  readPostgresCandidateConfiguration,
  resolvePostgresBindingCandidates,
} from "./ai-gateway-repository.ts";
import type { createManagedAiSecretStore } from "./managed-ai-secret-store.ts";

type ManagedStore = ReturnType<typeof createManagedAiSecretStore>;

function providerMessages(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("messages" in payload) || !Array.isArray(payload.messages)) {
    const error = new Error("AI_INPUT_INVALID") as Error & { code: string };
    error.code = "validation";
    throw error;
  }
  return payload.messages.map((message) => {
    if (!message || typeof message !== "object" || !("role" in message) || !("content" in message)) {
      const error = new Error("AI_INPUT_INVALID") as Error & { code: string };
      error.code = "validation";
      throw error;
    }
    const role = String(message.role);
    const content = String(message.content);
    if (!new Set(["system","user","assistant"]).has(role) || !content || content.length > 200_000) {
      const error = new Error("AI_INPUT_INVALID") as Error & { code: string };
      error.code = "validation";
      throw error;
    }
    return { role: role as "system" | "user" | "assistant",content };
  });
}

function requestedMaximum(payload: unknown, configured: number | null) {
  const requested = payload && typeof payload === "object" && "maxOutputTokens" in payload
    ? Number(payload.maxOutputTokens)
    : configured ?? 4_096;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw Object.assign(new Error("AI_INPUT_INVALID"),{ code: "validation" });
  }
  return Math.min(requested,configured ?? 4_096,32_768);
}

export function createAgentNovasAiGateway(input: {
  pool: Pool;
  secretStore: ManagedStore;
  providerAdapter: ProviderAdapter;
}) {
  const orchestrator = createInvocationOrchestrator({
    repository: createPostgresInvocationRepository(input.pool),
    resolveCandidates: request => resolvePostgresBindingCandidates(
      input.pool,request.roleKey,request.pinnedDeploymentRevisionId,
    ),
    usageSink: createPostgresUsageSink(input.pool),
    async invokeCandidate({ candidate,payload,signal }) {
      const configuration = await readPostgresCandidateConfiguration(input.pool,candidate);
      if (!configuration) throw { code: "configuration" };
      const apiKey = await input.secretStore.read(candidate.secretRef);
      try {
        return await input.providerAdapter.invoke({
          endpoint: configuration.endpoint,
          apiKey,
          modelId: configuration.model_id,
          messages: providerMessages(payload),
          maxOutputTokens: requestedMaximum(payload,configuration.max_output_tokens),
          signal,
        });
      } catch (error) {
        throw input.providerAdapter.classifyError(error);
      }
    },
  });
  return {
    async invoke(request: GatewayInvocationInput) {
      const expectedHash = await configurationFingerprint({
        roleKey: request.roleKey,
        operation: request.operation,
        payload: request.payload,
        ...(request.pinnedDeploymentRevisionId
          ? { pinnedDeploymentRevisionId: request.pinnedDeploymentRevisionId }
          : {}),
      });
      if (expectedHash !== request.requestHash) {
        const error = new Error("AI_INVOCATION_HASH_MISMATCH") as Error & { code: string };
        error.code = "AI_INVOCATION_HASH_MISMATCH";
        throw error;
      }
      return orchestrator.invoke(request);
    },
    async probe(request: { probeReceiptId: string; deploymentRevisionId: string; signal?: AbortSignal }) {
      const startedAt = Date.now();
      const configuration = await claimPostgresProbe(input.pool,{
        receiptId: request.probeReceiptId,deploymentRevisionId: request.deploymentRevisionId,
      });
      if (!configuration) throw Object.assign(new Error("AI_PROBE_NOT_CLAIMED"),{ code: "configuration" });
      try {
        const apiKey = await input.secretStore.read(configuration.secretRef);
        const models = await input.providerAdapter.discoverModels({
          endpoint: configuration.endpoint,apiKey,signal: request.signal,
        });
        const probe = await input.providerAdapter.probe({
          endpoint: configuration.endpoint,apiKey,modelId: configuration.modelId,
          messages: [{ role: "user",content: "Reply with OK only." }],
          maxOutputTokens: 1,signal: request.signal,
        });
        const latencyMs = Date.now()-startedAt;
        await completePostgresProbe(input.pool,{
          receiptId: configuration.receiptId,status: "succeeded",latencyMs,models,usage: probe.usage,
        });
        return { receipt: {
          id: configuration.receiptId,status: "succeeded" as const,latencyMs,models,
          configurationFingerprint: configuration.configurationFingerprint,
          testedAt: new Date().toISOString(),
        } };
      } catch (error) {
        const failure = input.providerAdapter.classifyError(error);
        const status = failure.code === "cancelled" ? "cancelled" as const : "failed" as const;
        await completePostgresProbe(input.pool,{
          receiptId: configuration.receiptId,status,latencyMs: Date.now()-startedAt,errorCode: failure.code,
        });
        throw failure;
      }
    },
  };
}
