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

export function createAgentNovasAiGateway(input: {
  pool: Pool;
  secretStore: ManagedStore;
  providerAdapter: ProviderAdapter;
}) {
  const orchestrator = createInvocationOrchestrator({
    repository: createPostgresInvocationRepository(input.pool),
    resolveCandidates: roleKey => resolvePostgresBindingCandidates(input.pool,roleKey),
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
          maxOutputTokens: Math.min(configuration.max_output_tokens ?? 4_096,32_768),
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
      });
      if (expectedHash !== request.requestHash) {
        const error = new Error("AI_INVOCATION_HASH_MISMATCH") as Error & { code: string };
        error.code = "AI_INVOCATION_HASH_MISMATCH";
        throw error;
      }
      return orchestrator.invoke(request);
    },
  };
}
