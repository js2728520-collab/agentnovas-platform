import {
  configurationFingerprint,
  type AiRoleKey,
  type GatewayInvocationResult,
} from "@agentnovas/ai-control-plane";

import { ResearchApiError } from "./research-errors.ts";

function gatewayUrl(path: string, environment: Record<string,string | undefined>) {
  const raw = environment.AI_GATEWAY_URL?.trim() || "http://127.0.0.1:3030";
  let origin: URL;
  try { origin = new URL(raw); } catch { throw new Error("AI_GATEWAY_URL_INVALID"); }
  if (origin.protocol !== "http:" || !new Set(["127.0.0.1","localhost","::1"]).has(origin.hostname)
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("AI_GATEWAY_URL_MUST_BE_LOOPBACK");
  }
  return new URL(path,origin);
}

function credentials(environment: Record<string,string | undefined>) {
  if (environment.AI_GATEWAY_ENABLED !== "true") {
    throw new ResearchApiError("AI_GATEWAY_DISABLED","AI Gateway 当前未启用",503);
  }
  const value = environment.AI_GATEWAY_SHARED_SECRET?.trim() ?? "";
  if (value.length < 32 || value.length > 512) {
    throw new ResearchApiError("AI_GATEWAY_UNAVAILABLE","AI Gateway 认证未配置",503);
  }
  return value;
}

async function gatewayRequest<T>(path: string,body: unknown,options: {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  environment?: Record<string,string | undefined>;
  timeoutMs?: number;
} = {}) {
  const environment = options.environment ?? process.env;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 50_000,1_000),120_000);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal,timeout]) : timeout;
  try {
    const response = await (options.fetchImpl ?? fetch)(gatewayUrl(path,environment),{
      method: "POST",
      headers: { "content-type": "application/json",authorization: `Bearer ${credentials(environment)}` },
      body: JSON.stringify(body),cache: "no-store",signal,
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: { code?: string } };
    if (!response.ok) throw new ResearchApiError(
      payload.error?.code ?? "AI_GATEWAY_REJECTED","AI Gateway 未完成请求",response.status,
    );
    return payload;
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("The operation was aborted","AbortError");
    }
    if (error instanceof ResearchApiError) throw error;
    throw new ResearchApiError("AI_GATEWAY_UNAVAILABLE","AI Gateway 暂不可用",503);
  }
}

export async function requestAiGatewayInvocation(input: {
  invocationId: string;
  roleKey: AiRoleKey;
  operation: string;
  payload: unknown;
  pinnedDeploymentRevisionId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  environment?: Record<string,string | undefined>;
  timeoutMs?: number;
}) {
  const requestHash = await configurationFingerprint({
    roleKey: input.roleKey,operation: input.operation,payload: input.payload,
    ...(input.pinnedDeploymentRevisionId ? { pinnedDeploymentRevisionId: input.pinnedDeploymentRevisionId } : {}),
  });
  return gatewayRequest<GatewayInvocationResult>("/v1/invoke",{
    invocationId: input.invocationId,requestHash,roleKey: input.roleKey,
    operation: input.operation,trafficKind: "business",payload: input.payload,
    ...(input.pinnedDeploymentRevisionId ? { pinnedDeploymentRevisionId: input.pinnedDeploymentRevisionId } : {}),
  },input);
}

export async function requestAiGatewayProbe(input: {
  probeReceiptId: string;
  deploymentRevisionId: string;
  requestedByUserId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  environment?: Record<string,string | undefined>;
}) {
  return gatewayRequest<{ receipt: unknown }>("/v1/probe",{
    probeReceiptId: input.probeReceiptId,
    deploymentRevisionId: input.deploymentRevisionId,
    requestedByUserId: input.requestedByUserId,
  },input);
}
