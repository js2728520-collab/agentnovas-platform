import { defineConfig, devices } from "@playwright/test";
import { join, resolve } from "node:path";

import {
  qualityApplicationPorts,
  qualityBrowserOrigin,
} from "./scripts/quality/quality-policy.mjs";

const repositoryRoot = process.cwd();
const outputRoot = resolve(
  repositoryRoot,
  process.env.QUALITY_E2E_OUTPUT_DIR ?? "outputs/quality-e2e",
);
const runtimeRoot = resolve(
  repositoryRoot,
  process.env.QUALITY_E2E_RUNTIME_DIR ?? join(outputRoot, ".runtime"),
);
const development = process.env.QUALITY_E2E_SERVER_MODE === "development";
const ports = qualityApplicationPorts(process.env);
const browserOrigins = {
  client: qualityBrowserOrigin("client", ports),
  operations: qualityBrowserOrigin("operations", ports),
  maintenance: qualityBrowserOrigin("maintenance", ports),
};
const serverCommand = (audience: "client" | "operations" | "maintenance") =>
  `RIVERTON_APP_AUDIENCE=${audience} NODE_USE_ENV_PROXY=1 ./node_modules/.bin/next ${development ? "dev" : "start"} -H 127.0.0.1 -p ${ports[audience]}`;

// Official Playwright guidance used here:
// https://playwright.dev/docs/test-webserver
// https://playwright.dev/docs/test-projects
// https://playwright.dev/docs/service-workers
export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["**/*.unit.test.mjs", "**/*.postgres.test.mjs"],
  outputDir: join(outputRoot, "test-results"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  globalTimeout: 20 * 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ["line"],
    ["junit", { outputFile: join(outputRoot, "results.xml") }],
    ["html", { outputFolder: join(outputRoot, "html-report"), open: "never" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    acceptDownloads: false,
    serviceWorkers: "block",
    launchOptions: {
      proxy: {
        server: "http://127.0.0.1:9",
        bypass: "agentnovas.com,zht.agentnovas.com,xm.agentnovas.com,127.0.0.1,localhost",
      },
      args: [
        "--host-resolver-rules=MAP agentnovas.com 127.0.0.1,MAP zht.agentnovas.com 127.0.0.1,MAP xm.agentnovas.com 127.0.0.1",
      ],
    },
    // Traces, videos, and screenshots can retain session cookies, MFA setup keys,
    // or recovery codes. Canonical CI evidence is textual and secret-scanned.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: process.env.QUALITY_E2E_SKIP_WEBSERVER === "true"
    ? undefined
    : [
        { command: serverCommand("client"), port: ports.client, reuseExistingServer: false, timeout: 120_000 },
        { command: serverCommand("operations"), port: ports.operations, reuseExistingServer: false, timeout: 120_000 },
        { command: serverCommand("maintenance"), port: ports.maintenance, reuseExistingServer: false, timeout: 120_000 },
      ],
  projects: [
    {
      name: "security-commercial",
      testMatch: ["host-cookie-audience.spec.ts", "commercial-flow.spec.ts", "g1-identity-security.spec.ts"],
    },
    {
      name: "client",
      testMatch: "client-ui.spec.ts",
      use: {
        baseURL: browserOrigins.client.baseURL,
        storageState: join(runtimeRoot, "client.storage-state.json"),
      },
    },
    {
      name: "operations-maker",
      testMatch: "operations-maker-ui.spec.ts",
      use: {
        baseURL: browserOrigins.operations.baseURL,
        storageState: join(runtimeRoot, "operationsMaker.storage-state.json"),
      },
    },
    {
      name: "operations-checker",
      testMatch: "operations-checker-ui.spec.ts",
      use: {
        baseURL: browserOrigins.operations.baseURL,
        storageState: join(runtimeRoot, "operationsChecker.storage-state.json"),
      },
    },
    {
      name: "maintenance-admin",
      testMatch: "maintenance-admin-ui.spec.ts",
      use: {
        baseURL: browserOrigins.maintenance.baseURL,
        storageState: join(runtimeRoot, "maintenanceAdmin.storage-state.json"),
      },
    },
  ],
});
