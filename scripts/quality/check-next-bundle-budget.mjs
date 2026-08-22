import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  assertWithinBundleBudget,
  measureNextInitialAssets,
} from "./next-bundle-budget.mjs";

async function main() {
  const repositoryRoot = process.cwd();
  const applications = ["client", "operations", "maintenance"];
  const report = {
    generatedAt: new Date().toISOString(),
    budgets: {
      javascriptGzipBytes: 200 * 1024,
      cssGzipBytes: 50 * 1024,
    },
    applications: [],
  };

  for (const name of applications) {
    let measurement;
    try {
      measurement = await measureNextInitialAssets(
        resolve(repositoryRoot, `.next-${name}`),
        "/page",
      );
      assertWithinBundleBudget(measurement, report.budgets);
      report.applications.push({ name, passed: true, ...measurement });
    } catch (error) {
      report.applications.push({
        name,
        passed: false,
        ...(measurement ?? {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const outputPath = resolve(
    repositoryRoot,
    process.env.QUALITY_BUNDLE_REPORT ?? "outputs/quality-bundle/report.json",
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const failures = report.applications.filter((application) => !application.passed);
  if (failures.length) {
    throw new Error(`Next bundle budgets failed for: ${failures.map((failure) => failure.name).join(", ")}; report: ${outputPath}`);
  }
  process.stdout.write(`Next bundle budgets passed: ${outputPath}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
