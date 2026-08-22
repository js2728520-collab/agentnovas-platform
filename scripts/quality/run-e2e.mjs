#!/usr/bin/env node
import { runQualityE2e } from "./quality-e2e-runner.mjs";

try {
  await runQualityE2e({ args: process.argv.slice(2) });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Quality E2E failed"}\n`);
  process.exitCode = 1;
}
