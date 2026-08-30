#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const AUDIENCES = ["client", "operations", "maintenance"];
const repositoryRoot = process.cwd();
const retainIntermediateArtifacts = process.env.QUALITY_RETAIN_NEXT_INTERMEDIATE_ARTIFACTS === "true";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal) {
        rejectRun(new Error(`${command} ${args.join(" ")} 被信号 ${signal} 中止`));
        return;
      }
      if (code !== 0) {
        rejectRun(new Error(`${command} ${args.join(" ")} 退出码 ${code ?? "unknown"}`));
        return;
      }
      resolveRun();
    });
  });
}

for (const audience of AUDIENCES) {
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", `build:${audience}`]);

  // Turbopack cache and the outer server tree are intermediate artifacts. The standalone
  // tree contains the traced server files that are actually deployed, while static and
  // build metadata remain beside it. Releasing the duplicates prevents three-audience
  // builds from exhausting constrained CI/worktree volumes without weakening production
  // E2E or the key-custody scan of the deployable bundle.
  if (!retainIntermediateArtifacts) {
    await Promise.all([
      rm(resolve(repositoryRoot, `.next-${audience}`, "cache"), {
        recursive: true,
        force: true,
      }),
      rm(resolve(repositoryRoot, `.next-${audience}`, "server"), {
        recursive: true,
        force: true,
      }),
    ]);
    process.stdout.write(`  ✓ ${audience} intermediate build artifacts released\n`);
  }
}
