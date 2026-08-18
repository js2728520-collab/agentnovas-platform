function privateNetworkHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost"
    || host === "0.0.0.0"
    || host === "::"
    || host === "::1"
    || host.endsWith(".local")
    || host.endsWith(".internal")
  ) return true;

  if (host.includes(":")) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host)
      || host.startsWith("2001:db8");
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  if (!ipv4 || ipv4.some(part => part > 255)) return false;
  const [a, b, c] = ipv4;
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
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
