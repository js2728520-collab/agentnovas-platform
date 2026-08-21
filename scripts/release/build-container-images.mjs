import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import { releaseIdentity } from "./release-identity.mjs";

const argumentsList = process.argv.slice(2);
const versionInput = argumentsList.find((value) => !value.startsWith("--")) ?? process.env.RIVERTON_RELEASE_TAG;
const platform = argumentsList.find((value) => value.startsWith("--platform="))?.split("=")[1] ?? "linux/amd64";
const identity = await releaseIdentity(versionInput);
const prefix = process.env.RIVERTON_IMAGE_PREFIX?.trim() || "agentnovas-riverton";

const images = [
  { name: "client", target: "web", audience: "client", host: "agentnovas.com" },
  { name: "operations", target: "web", audience: "operations", host: "zht.agentnovas.com" },
  { name: "maintenance", target: "web", audience: "maintenance", host: "xm.agentnovas.com" },
  { name: "runtime", target: "runtime", audience: "", host: "" },
];

for (const image of images) {
  const reference = `${prefix}-${image.name}:${identity.version}`;
  const command = [
    "buildx", "build", "--platform", platform, "--target", image.target,
    "--build-arg", `RIVERTON_RELEASE_TAG=${identity.versionTag}`,
    "--build-arg", `GIT_COMMIT_SHA=${identity.commitSha}`,
    "--label", `org.opencontainers.image.version=${identity.versionTag}`,
    "--label", `org.opencontainers.image.revision=${identity.commitSha}`,
    "--load", "--tag", reference,
  ];
  if (image.audience) command.push("--build-arg", `RIVERTON_APP_AUDIENCE=${image.audience}`);
  if (image.host) command.push("--build-arg", `RIVERTON_APP_HOST=${image.host}`);
  command.push(".");
  const result = spawnSync("docker", command, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const inspected = images.map((image) => {
  const reference = `${prefix}-${image.name}:${identity.version}`;
  const payload = JSON.parse(execFileSync("docker", ["image", "inspect", reference], { encoding: "utf8" }))[0];
  return { name: image.name, reference, imageId: payload.Id, platform };
});
const artifactInput = JSON.stringify({
  versionTag: identity.versionTag,
  commitSha: identity.commitSha,
  migrationVersion: identity.migrationVersion,
  images: inspected,
});
const artifactSha256 = createHash("sha256").update(artifactInput).digest("hex");
const manifest = { ...identity, artifactSha256, platform, images: inspected };
const outputDirectory = new URL("../../outputs/releases/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(new URL(`${identity.version}.json`, outputDirectory), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(manifest)}\n`);
