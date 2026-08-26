const EXTERNAL_EFFECT_FLAGS = [
  "PAYMENT_WORKER_ENABLED",
  "PAYMENT_PROVIDER_TESTS_ENABLED",
  "NOTIFICATION_WORKER_ENABLED",
  "NOTIFICATION_EMAIL_SEND_ENABLED",
  "DEMO_EXECUTION_WORKER_ENABLED",
  "CONFIGURATION_ACTIVATION_WORKER_ENABLED",
  "PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED",
  "PLATFORM_DEMO_VERIFICATION_ENABLED",
  "STRATEGY_RESEARCH_ENABLED",
  "STRATEGY_RUNTIME_ENABLED",
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const QUALITY_APP_HOST_BY_AUDIENCE = Object.freeze({
  client: "agentnovas.com",
  operations: "zht.agentnovas.com",
  maintenance: "xm.agentnovas.com",
});
const QUALITY_APP_HOSTS = new Set(Object.values(QUALITY_APP_HOST_BY_AUDIENCE));

export function isExpectedQualityBrowserWarning(message) {
  const match = String(message).match(/^The resource (https:\/\/[^\s]+) was preloaded using link preload but not used within a few seconds from the window's load event\. Please make sure it has an appropriate `as` value and it is preloaded intentionally\.$/);
  if (!match) return false;
  try {
    const url = new URL(match[1]);
    return QUALITY_APP_HOSTS.has(url.hostname.toLowerCase())
      && url.pathname.startsWith("/_next/static/chunks/");
  } catch {
    return false;
  }
}

export function assertQualitySideEffectsDisabled(environment = process.env) {
  for (const key of EXTERNAL_EFFECT_FLAGS) {
    if (environment[key]?.trim().toLowerCase() === "true") {
      throw new Error(`${key} must not be true during quality evidence runs`);
    }
  }
}

export function assertSafeFixtureDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Quality fixture requires a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("Quality fixture requires a PostgreSQL URL");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Quality fixture may connect only to local PostgreSQL");
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error("Quality fixture PostgreSQL URL must name a database");
  }
  return url;
}

export function qualitySchemaName(runId) {
  const suffix = String(runId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  if (suffix.length < 4) throw new Error("Quality run id is too short for an isolated schema");
  return `quality_e2e_${suffix}`;
}

export function qualityApplicationPorts(environment = process.env) {
  const raw = environment.QUALITY_E2E_PORT_OFFSET ?? "0";
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0 || offset > 62_500) {
    throw new Error("QUALITY_E2E_PORT_OFFSET must be an integer port offset from 0 through 62500");
  }
  return { client: 3000 + offset, operations: 3001 + offset, maintenance: 3002 + offset };
}

export function qualityBrowserOrigin(audience, ports) {
  const hostname = QUALITY_APP_HOST_BY_AUDIENCE[audience];
  const port = ports?.[audience];
  if (!hostname || !Number.isInteger(port)) throw new Error("Unknown quality browser audience");
  return { baseURL: `https://${hostname}:${port}` };
}

export function qualityLoopbackForward(value, ports) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const audience = Object.entries(QUALITY_APP_HOST_BY_AUDIENCE)
    .find(([, hostname]) => hostname === url.hostname.toLowerCase())?.[0];
  if (!audience || !["http:", "https:"].includes(url.protocol)) return null;
  const port = ports?.[audience];
  if (!Number.isInteger(port) || url.port !== String(port) || url.username || url.password) return null;
  return {
    url: `http://127.0.0.1:${port}${url.pathname}${url.search}`,
    host: url.host,
  };
}

export function assertSafeQualitySchema(schema) {
  if (!/^quality_e2e_[a-z0-9_]{4,42}$/.test(schema)) {
    throw new Error("Unsafe quality fixture schema name");
  }
  return schema;
}

export function postgresUrlForSchema(value, schema) {
  const url = assertSafeFixtureDatabaseUrl(value);
  assertSafeQualitySchema(schema);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url;
}

export function isAllowedQualityNetworkUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "data:") return true;
  if (url.protocol === "blob:") return isAllowedQualityNetworkUrl(value.slice("blob:".length));
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  return LOOPBACK_HOSTS.has(url.hostname) || QUALITY_APP_HOSTS.has(url.hostname);
}

export function redactPotentialSecrets(value) {
  return String(value ?? "")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]")
    .replace(/\b(api[_-]?key|password|passwd|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 2_000);
}

export const qualityExternalEffectFlags = Object.freeze([...EXTERNAL_EFFECT_FLAGS]);
