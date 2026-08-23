import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { hashPassword, sha256 } from "../lib/auth.ts";
import { consumePasswordReset } from "../lib/password-reset.ts";
import {
  cleanupQualityDatabaseFixture,
  prepareQualityDatabaseFixture,
} from "../scripts/quality/quality-database-fixture.mjs";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `quality_e2e_reset_full_${process.pid}`;
let directory;
let fixture;
let pool;

test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentnovas-reset-full-"));
  fixture = await prepareQualityDatabaseFixture({
    adminDatabaseUrl,
    schema,
    outputDirectory: directory,
  });
  pool = new pg.Pool({ connectionString: fixture.applicationDatabaseUrl, max: 2 });
});

test.after(async () => {
  await pool?.end();
  if (fixture) await cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema });
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("Client password reset remains atomic with the complete migration chain and audit trigger", async () => {
  const identity = fixture.identities.clientSecurity;
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256(token);
  await pool.query(`
    INSERT INTO auth_tokens(id,user_id,token_hash,purpose,token_audience,expires_at)
    VALUES($1,$2,$3,'reset_password','client',now() + interval '1 hour')
  `, [crypto.randomUUID(), identity.userId, tokenHash]);

  assert.deepEqual(await consumePasswordReset(pool, {
    tokenHash,
    passwordHash: await hashPassword(`Quality-${crypto.randomUUID()}-aA1!`),
    audience: "client",
  }), {
    ok: true,
    accountActivated: false,
    primarySessionCreated: false,
    mfaEnrollmentRequired: false,
  });

  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM auth_tokens
    WHERE id IS NOT NULL AND user_id=$1 AND purpose='reset_password' AND used_at IS NULL
  `, [identity.userId])).rows[0].count, 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM audit_logs
    WHERE actor_user_id=$1 AND action='auth.password_reset' AND row_hash IS NOT NULL
  `, [identity.userId])).rows[0].count, 1);
});
