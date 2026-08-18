import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  bindAgentRole,
  listAgentRoleBindings,
  listLlmProfiles,
  missingAgentRoles,
  resolveAgentRoleConfig,
  saveLlmProfile,
} from "../lib/agent-model-profiles.ts";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `agent_profile_test_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const originalEncryptionKey = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY;

test.before(async () => {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = "test-only-encryption-key-with-32-chars";
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migration = await readFile(new URL("../postgres/migrations/0001_strategy_research.sql", import.meta.url), "utf8");
  await pool.query(migration);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  if (originalEncryptionKey === undefined) delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = originalEncryptionKey;
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE agent_role_bindings, llm_profiles CASCADE");
});

test("encrypts profile keys and never exposes plaintext in administrator listings", async () => {
  const saved = await saveLlmProfile(pool, {
    actorUserId: "admin-a",
    input: {
      name: "策略研究主模型",
      providerName: "Private Provider",
      baseUrl: "https://llm.example.com/v1",
      modelName: "quant-model-1",
      apiKey: "sk-test-secret-never-return",
      enabled: true,
    },
  });
  const raw = await pool.query("SELECT encrypted_api_key FROM llm_profiles WHERE id = $1", [saved.id]);
  const listed = await listLlmProfiles(pool);

  assert.notEqual(raw.rows[0].encrypted_api_key, "sk-test-secret-never-return");
  assert.equal(listed[0].modelName, "quant-model-1");
  assert.equal(listed[0].hasApiKey, true);
  assert.match(listed[0].maskedApiKey, /^sk-t.*turn$/);
  assert.equal("apiKey" in listed[0], false);
  assert.equal("encryptedApiKey" in listed[0], false);
});

test("binds roles and gives customers model names without provider or endpoint metadata", async () => {
  const profile = await saveLlmProfile(pool, {
    actorUserId: "admin-a",
    input: {
      name: "反方模型",
      providerName: "Provider Must Stay Private",
      baseUrl: "https://llm.example.com/v1/responses",
      modelName: "critic-2",
      apiKey: "sk-test-role-secret",
      enabled: true,
    },
  });
  await bindAgentRole(pool, {
    actorUserId: "admin-a",
    role: "adversarial_review",
    profileId: profile.id,
    enabled: true,
  });

  const publicBindings = await listAgentRoleBindings(pool, { visibility: "customer" });
  const resolved = await resolveAgentRoleConfig(pool, "adversarial_review");

  assert.deepEqual(publicBindings[0], {
    role: "adversarial_review",
    modelName: "critic-2",
    enabled: true,
    configured: true,
  });
  assert.equal(JSON.stringify(publicBindings).includes("Provider Must Stay Private"), false);
  assert.equal(JSON.stringify(publicBindings).includes("llm.example.com"), false);
  assert.equal(resolved.apiKey, "sk-test-role-secret");
  assert.equal(resolved.apiStyle, "responses");
});

test("reports every missing critical role and ignores bindings to disabled profiles", async () => {
  const profile = await saveLlmProfile(pool, {
    actorUserId: "admin-a",
    input: {
      name: "已停用模型",
      providerName: "Provider",
      baseUrl: "https://llm.example.com/v1",
      modelName: "disabled-1",
      apiKey: "sk-disabled-secret",
      enabled: false,
    },
  });
  await bindAgentRole(pool, {
    actorUserId: "admin-a",
    role: "requirements",
    profileId: profile.id,
    enabled: true,
  });

  const missing = await missingAgentRoles(pool);

  assert.equal(missing.length, 7);
  assert.ok(missing.includes("requirements"));
});

test("rejects insecure or private model endpoints", async () => {
  const base = {
    name: "无效模型",
    providerName: "Provider",
    modelName: "model",
    apiKey: "sk-test-secret",
    enabled: true,
  };
  await assert.rejects(
    saveLlmProfile(pool, { actorUserId: "admin-a", input: { ...base, baseUrl: "http://llm.example.com/v1" } }),
    /HTTPS/,
  );
  await assert.rejects(
    saveLlmProfile(pool, { actorUserId: "admin-a", input: { ...base, baseUrl: "https://127.0.0.1/v1" } }),
    /内网/,
  );
});
