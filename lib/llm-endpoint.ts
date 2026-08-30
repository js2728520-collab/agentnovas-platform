import { BlockList, isIP } from "node:net";

const nonPublicIpv4Addresses = new BlockList();
for (const [network,prefix] of [
  ["0.0.0.0",8],
  ["10.0.0.0",8],
  ["100.64.0.0",10],
  ["127.0.0.0",8],
  ["169.254.0.0",16],
  ["172.16.0.0",12],
  ["192.0.0.0",24],
  ["192.0.2.0",24],
  ["192.88.99.0",24],
  ["192.168.0.0",16],
  ["198.18.0.0",15],
  ["198.51.100.0",24],
  ["203.0.113.0",24],
  ["224.0.0.0",4],
  ["240.0.0.0",4],
] as const) nonPublicIpv4Addresses.addSubnet(network,prefix,"ipv4");
const nonPublicIpv6Addresses = new BlockList();
for (const [network,prefix] of [
  ["::",128],
  ["::1",128],
  ["::ffff:0:0",96],
  ["64:ff9b::",96],
  ["64:ff9b:1::",48],
  ["100::",64],
  ["2001::",23],
  ["2001:db8::",32],
  ["2002::",16],
  ["fc00::",7],
  ["fe80::",10],
  ["ff00::",8],
] as const) nonPublicIpv6Addresses.addSubnet(network,prefix,"ipv6");

export function privateNetworkHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost"
    || host.endsWith(".local")
    || host.endsWith(".internal")
  ) return true;
  const family = isIP(host);
  return family === 4
    ? nonPublicIpv4Addresses.check(host,"ipv4")
    : family === 6
      ? nonPublicIpv6Addresses.check(host,"ipv6")
      : false;
}

export function normalizeLlmBaseUrl(value: unknown) {
  const input = String(value ?? "").trim().replace(/\/+$/, "");
  if (!input || input.length > 2048) throw new Error("请填写有效的接口地址");
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("接口地址格式不正确");
  }
  if (parsed.protocol !== "https:") throw new Error("接口地址必须使用 HTTPS");
  if (parsed.username || parsed.password) throw new Error("接口地址不能包含账号或密码");
  if (parsed.search || parsed.hash) throw new Error("接口地址不能包含查询参数或锚点");
  if (privateNetworkHost(parsed.hostname)) throw new Error("接口地址不能指向本机或内网地址");
  return input;
}

export function normalizeLlmCompletionEndpoint(baseUrl: string) {
  const normalized = normalizeLlmBaseUrl(baseUrl);
  if (/\/responses$/i.test(normalized)) return { endpoint: normalized, apiStyle: "responses" as const };
  if (/\/chat\/completions$/i.test(normalized)) {
    return { endpoint: normalized, apiStyle: "chat_completions" as const };
  }
  return { endpoint: `${normalized}/chat/completions`, apiStyle: "chat_completions" as const };
}

/**
 * 由 base_url 推出模型列表端点。
 *
 * OpenAI 兼容协议约定 `GET {base}/models`。这里要处理运维填了完整补全路径的情况——
 * 填 `.../v1/chat/completions` 时，模型列表在 `.../v1/models` 而不是
 * `.../v1/chat/completions/models`。
 */
export function normalizeLlmModelsEndpoint(baseUrl: string) {
  const normalized = normalizeLlmBaseUrl(baseUrl);
  const base = normalized
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/responses$/i, "")
    .replace(/\/$/, "");
  return `${base}/models`;
}
