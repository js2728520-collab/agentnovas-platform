import { lookup as dnsLookup } from "node:dns/promises";

import type { Pool, PoolClient } from "pg";

import {
  resolveAgentRoleConfig,
  resolveRuntimeExplanationRoleConfig,
} from "./agent-model-profiles.ts";
import type { ResolvedLlmProfileConfig } from "./research-types.ts";
import { privateNetworkHost } from "./llm-endpoint.ts";

type Queryable = Pick<Pool | PoolClient, "query">;
type LookupAddress = { address: string };

async function assertPublicDns(hostname: string, resolver: (hostname: string) => Promise<LookupAddress[]> = async host => {
  const result = await dnsLookup(host, { all: true, verbatim: true });
  return result.map(item => ({ address: item.address }));
}) {
  if (privateNetworkHost(hostname)) throw new Error("接口地址不能指向本机或内网地址");
  const addresses = await resolver(hostname);
  if (!addresses.length || addresses.some(item => privateNetworkHost(item.address))) {
    throw new Error("接口域名解析到了内网或无效地址");
  }
}

export async function assertPublicLlmEndpoint(
  endpoint: string,
  resolver?: (hostname: string) => Promise<LookupAddress[]>,
) {
  const target = new URL(endpoint);
  if (target.protocol !== "https:") throw new Error("模型接口必须使用 HTTPS");
  await assertPublicDns(target.hostname, resolver);
}

export async function testAgentRoleConnection(database: Queryable, options: {
  role: string;
  fetchImpl?: typeof fetch;
  resolver?: (hostname: string) => Promise<LookupAddress[]>;
  timeoutMs?: number;
}) {
  const config = await resolveAgentRoleConfig(database, options.role);
  if (!config) throw new Error("该角色尚未绑定可用模型");
  return testResolvedModelConnection(config, options);
}

export async function testRuntimeExplanationRoleConnection(database: Queryable, options: {
  role: string;
  fetchImpl?: typeof fetch;
  resolver?: (hostname: string) => Promise<LookupAddress[]>;
  timeoutMs?: number;
}) {
  const config = await resolveRuntimeExplanationRoleConfig(database, options.role);
  if (!config) throw new Error("该运行时解释角色尚未绑定可用模型");
  return testResolvedModelConnection(config, options);
}

async function testResolvedModelConnection(config: ResolvedLlmProfileConfig, options: {
  fetchImpl?: typeof fetch;
  resolver?: (hostname: string) => Promise<LookupAddress[]>;
  timeoutMs?: number;
}) {
  await assertPublicLlmEndpoint(config.endpoint, options.resolver);

  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 12_000, 1_000), 30_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const body = config.apiStyle === "responses"
      ? { model: config.model, input: "Reply with OK only.", max_output_tokens: 1 }
      : { model: config.model, messages: [{ role: "user", content: "Reply with OK only." }], max_tokens: 1 };
    const response = await (options.fetchImpl ?? fetch)(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("API Key 无效或没有权限");
      if (response.status === 404) throw new Error("接口路径不存在");
      throw new Error(`模型服务返回 HTTP ${response.status}`);
    }
    return {
      ok: true,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      apiStyle: config.apiStyle,
      modelName: config.modelName,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`连接超时（${timeoutMs / 1_000} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
