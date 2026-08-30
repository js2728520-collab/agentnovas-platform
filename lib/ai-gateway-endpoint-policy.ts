import { lookup as dnsLookup } from "node:dns/promises";

import { normalizeLlmBaseUrl, privateNetworkHost } from "./llm-endpoint.ts";

type ResolverResult = { address: string; family: number };

class EndpointPolicyError extends Error {
  code = "AI_ENDPOINT_BLOCKED";

  constructor() {
    super("AI Provider endpoint is not permitted by the public HTTPS policy");
    this.name = "EndpointPolicyError";
  }
}

export function createPublicHttpsEndpointPolicy(options: {
  resolve?: (hostname: string) => Promise<readonly ResolverResult[]>;
} = {}) {
  const resolveHost = options.resolve
    ?? (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  return {
    async assertAllowed(endpoint: string) {
      let normalized: string;
      try {
        normalized = normalizeLlmBaseUrl(endpoint);
      } catch {
        throw new EndpointPolicyError();
      }
      const target = new URL(normalized);
      let addresses: readonly ResolverResult[];
      try {
        addresses = await resolveHost(target.hostname);
      } catch {
        throw new EndpointPolicyError();
      }
      if (!addresses.length || addresses.some(item => privateNetworkHost(item.address))) {
        throw new EndpointPolicyError();
      }
      const pinnedAddresses = [...new Set(addresses.map(item => item.address))];
      return { endpoint: normalized,hostname: target.hostname,pinnedAddresses };
    },
  };
}
