import { writeQualityReleaseEvidence } from "./quality-release-evidence.mjs";

try {
  const root = process.env.QUALITY_OUTPUT_ROOT ?? "outputs";
  await writeQualityReleaseEvidence(root);
  process.stdout.write(`Quality release evidence verified: ${root}/release-evidence.json\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
