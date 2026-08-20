import { runQualityLighthouse } from "./quality-lighthouse-runner.mjs";

try {
  await runQualityLighthouse();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
