import { lookup as dnsLookup } from "node:dns/promises";

import { privateNetworkHost } from "./llm-endpoint.ts";

type LookupAddress = { address: string };

async function assertPublicDns(
  hostname: string,
  resolver: (hostname: string) => Promise<LookupAddress[]> = async host => {
    const result = await dnsLookup(host,{ all: true,verbatim: true });
    return result.map(item => ({ address: item.address }));
  },
) {
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
  await assertPublicDns(target.hostname,resolver);
}
