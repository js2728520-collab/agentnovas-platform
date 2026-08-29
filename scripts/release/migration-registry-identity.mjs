import { pathToFileURL } from "node:url";

import {
  loadPostgresMigrations,
  migrationRegistrySha256,
} from "../postgres-migration-runner.mjs";

export async function migrationRegistryIdentity(
  directory = new URL("../../postgres/migrations/", import.meta.url),
) {
  const migrations = await loadPostgresMigrations(directory);
  return {
    migrationRegistrySha256: migrationRegistrySha256(migrations),
    migrationVersion: migrations.at(-1).name.slice(0, -4),
    migrationCount: migrations.length,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  migrationRegistryIdentity().then(
    (identity) => process.stdout.write(`${JSON.stringify(identity)}\n`),
    () => {
      process.stderr.write("Migration registry identity unavailable\n");
      process.exitCode = 1;
    },
  );
}
