#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "agentnovas-ai-control-plane-pack-"));

function run(command, args, cwd = repoRoot) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

try {
  const packDirectory = join(temporaryRoot, "packs");
  const fixtureDirectory = join(temporaryRoot, "consumer");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(fixtureDirectory, { recursive: true }),
  ]));

  const coreOutput = run("npm", ["pack", "./packages/ai-control-plane", "--pack-destination", packDirectory, "--json"]);
  const reactOutput = run("npm", ["pack", "./packages/ai-control-plane-react", "--pack-destination", packDirectory, "--json"]);
  const coreTarball = JSON.parse(coreOutput)[0]?.filename;
  const reactTarball = JSON.parse(reactOutput)[0]?.filename;
  if (!coreTarball || !reactTarball) throw new Error("AI_CONTROL_PLANE_PACK_OUTPUT_INVALID");

  await writeFile(join(fixtureDirectory, "package.json"), JSON.stringify({
    name: "ai-control-plane-consumer-smoke",
    private: true,
    type: "module",
    dependencies: {
      "@agentnovas/ai-control-plane": `file:${join(packDirectory, coreTarball)}`,
      "@agentnovas/ai-control-plane-react": `file:${join(packDirectory, reactTarball)}`,
      react: "19.2.6",
      "react-dom": "19.2.6",
    },
    devDependencies: {
      "@types/react": "19.2.14",
      "@types/react-dom": "19.2.3",
      typescript: "5.9.3",
    },
  }, null, 2));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--package-lock=false"], fixtureDirectory);

  await writeFile(join(fixtureDirectory, "consumer.mjs"), `
import { AI_ROLE_CATALOG } from "@agentnovas/ai-control-plane";
import { AiControlPlaneManager } from "@agentnovas/ai-control-plane-react";
if (AI_ROLE_CATALOG.length !== 12 || typeof AiControlPlaneManager !== "function") {
  throw new Error("AI_CONTROL_PLANE_CONSUMER_SMOKE_FAILED");
}
`);
  run("node", ["consumer.mjs"], fixtureDirectory);

  await writeFile(join(fixtureDirectory, "consumer.tsx"), `
import type { AiControlPlaneClient, RoleDescriptor } from "@agentnovas/ai-control-plane";
import { AiControlPlaneManager } from "@agentnovas/ai-control-plane-react";
declare const client: AiControlPlaneClient;
declare const roles: readonly RoleDescriptor[];
export const view = <AiControlPlaneManager client={client} roles={roles} formatDateTime={String} messages={{
  title: "AI", refresh: "Refresh", loading: "Loading", error: "Error", empty: "Empty",
  connections: "Connections", deployments: "Deployments", bindings: "Bindings", probes: "Probes",
  budgets: "Budgets", enabled: "Enabled", disabled: "Disabled", primary: "Primary", fallback: "Fallback",
}} />;
`);
  run(join(repoRoot, "node_modules/.bin/tsc"), [
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--jsx", "react-jsx", "consumer.tsx",
  ], fixtureDirectory);

  const coreManifest = JSON.parse(await readFile(join(fixtureDirectory, "node_modules/@agentnovas/ai-control-plane/package.json"), "utf8"));
  const reactManifest = JSON.parse(await readFile(join(fixtureDirectory, "node_modules/@agentnovas/ai-control-plane-react/package.json"), "utf8"));
  console.log(JSON.stringify({
    ok: true,
    core: `${coreManifest.name}@${coreManifest.version}`,
    react: `${reactManifest.name}@${reactManifest.version}`,
    consumer: "node+typescript+react",
  }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
