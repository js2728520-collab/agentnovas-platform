import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type QualityIdentity = {
  userId: string;
  email: string;
  password: string;
  token: string;
  audience: "client" | "operations" | "maintenance";
  domain: string;
  cookieName: string;
  storageState: string;
};

export type QualityRuntime = {
  schema: string;
  externalWritesEnabled: false;
  organizationId: string;
  createdAt: string;
  expiresAt: string;
  baseUrls: Record<"client" | "operations" | "maintenance", string>;
  identities: Record<
    "client" | "clientSecurity" | "operationsMaker" | "operationsChecker" | "maintenanceAdmin",
    QualityIdentity
  >;
  researchFixture: {
    runId: string;
    candidateId: string;
    exchangeAccountId: string;
  };
};

export async function readQualityRuntime(): Promise<QualityRuntime> {
  const directory = process.env.QUALITY_E2E_RUNTIME_DIR;
  if (!directory) throw new Error("QUALITY_E2E_RUNTIME_DIR is required");
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8")) as QualityRuntime;
  if (runtime.externalWritesEnabled !== false || !runtime.schema.startsWith("quality_e2e_")) {
    throw new Error("Unsafe or malformed quality runtime fixture");
  }
  return runtime;
}

export function identityCookie(identity: QualityIdentity) {
  return `${identity.cookieName}=${encodeURIComponent(identity.token)}`;
}

export const officialHosts = {
  client: "agentnovas.com",
  operations: "zht.agentnovas.com",
  maintenance: "xm.agentnovas.com",
} as const;

export function officialRequestHeaders(
  audience: keyof typeof officialHosts,
  identity?: QualityIdentity,
) {
  return {
    Host: officialHosts[audience],
    Origin: `https://${officialHosts[audience]}`,
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-proto": "https",
    ...(identity ? { Cookie: identityCookie(identity) } : {}),
  };
}
