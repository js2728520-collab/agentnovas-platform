import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { migrationRegistryIdentity } from "../scripts/release/migration-registry-identity.mjs";

test("migration image identity binds ordered names and SQL checksums", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migration-identity-"));
  try {
    await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(join(directory, "0002_second.sql"), "SELECT 2;\n");
    const identity = await migrationRegistryIdentity(new URL("./", pathToFileURL(`${directory}/`)));
    assert.match(identity.migrationRegistrySha256, /^[a-f0-9]{64}$/);
    assert.equal(identity.migrationVersion, "0002_second");
    assert.equal(identity.migrationCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
