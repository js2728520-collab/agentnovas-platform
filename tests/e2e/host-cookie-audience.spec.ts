import { request } from "@playwright/test";

import { expect, test } from "./support/quality-test";
import {
  officialHosts,
  officialRequestHeaders,
  readQualityRuntime,
} from "./support/runtime";

test("unknown and cross-audience hosts fail closed", async () => {
  const runtime = await readQualityRuntime();
  const client = await request.newContext({ baseURL: runtime.baseUrls.client });
  try {
    const official = await client.get("/api/auth/me", {
      headers: officialRequestHeaders("client", runtime.identities.client),
    });
    expect(official.status()).toBe(200);
    expect((await official.json()).user?.id).toBe(runtime.identities.client.userId);

    for (const host of ["evil.invalid", officialHosts.operations, officialHosts.maintenance]) {
      const rejected = await client.get("/api/auth/me", { headers: { Host: host } });
      expect(rejected.status(), host).toBe(404);
    }
  } finally {
    await client.dispose();
  }
});

test("audience-specific cookies cannot authenticate another application", async () => {
  const runtime = await readQualityRuntime();
  const operations = await request.newContext({ baseURL: runtime.baseUrls.operations });
  try {
    const response = await operations.get("/api/auth/me", {
      headers: {
        ...officialRequestHeaders("operations"),
        Cookie: `${runtime.identities.maintenanceAdmin.cookieName}=${runtime.identities.maintenanceAdmin.token}`,
      },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).user).toBeNull();
  } finally {
    await operations.dispose();
  }
});

test("login cookies are secure, HttpOnly, Strict and audience-bound", async () => {
  const runtime = await readQualityRuntime();
  const cases = [
    ["client", runtime.identities.client],
    ["operations", runtime.identities.operationsMaker],
    ["operations", runtime.identities.operationsChecker],
    ["maintenance", runtime.identities.maintenanceAdmin],
  ] as const;

  for (const [audience, identity] of cases) {
    const context = await request.newContext({ baseURL: runtime.baseUrls[audience] });
    try {
      const response = await context.post("/api/auth/login", {
        headers: officialRequestHeaders(audience),
        data: { identifier: identity.email, password: identity.password },
      });
      expect(response.status(), `${audience}:${identity.userId}`).toBe(200);
      const payload = await response.json();
      expect(payload.appAudience).toBe(audience);
      expect(payload.mfaEnforcementEnabled).toBe(false);
      expect(payload.mfaRequired).toBe(false);
      const cookies = response.headersArray()
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value);
      expect(cookies.some((cookie) => cookie.startsWith(`${identity.cookieName}=`))).toBe(true);
      for (const cookie of cookies) {
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain("Secure");
      }
    } finally {
      await context.dispose();
    }
  }
});
