import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const PRODUCTION_D1_DATABASE = {
  name: "agentnovas-db",
  id: "d8db69b3-8fb9-49cc-95e8-61b1bde92e15",
};

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  name: "agentnovas-platform",
  main: "./worker/index.ts",
  workers_dev: true,
  routes: [
    { pattern: "tzxsea.com", custom_domain: true },
    { pattern: "www.tzxsea.com", custom_domain: true },
  ],
  compatibility_flags: ["nodejs_compat"],
  triggers: { crons: ["*/5 * * * *"] },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: PRODUCTION_D1_DATABASE.name,
          database_id: PRODUCTION_D1_DATABASE.id,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
        inspectorPort: false,
      }),
    ],
  };
});
