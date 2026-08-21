import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  bindAgentRole,
  bindRuntimeExplanationRole,
  listAgentRoleBindings,
  listLlmProfiles,
  listLlmProfileRevisions,
  listRuntimeExplanationBindings,
  missingAgentRoles,
  resolveAgentRoleConfig,
  resolveRuntimeExplanationRoleConfig,
  rollbackLlmProfileRevision,
  saveLlmProfile,
  snapshotAgentRoleBindings,
} from "../lib/agent-model-profiles.ts";
import { testAgentRoleConnection } from "../lib/llm-profile-connection.ts";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `agent_profile_test_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const originalEncryptionKey = process.env.LLM_PROFILE_ENCRYPTION_KEY;

test.before(async () => {
  process.env.LLM_PROFILE_ENCRYPTION_KEY = "test-only-llm-profile-key-with-32-chars";
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migration = await readFile(new URL("../postgres/migrations/0001_strategy_research.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query("CREATE TABLE IF NOT EXISTS audit_logs(id text PRIMARY KEY,actor_user_id text,action text NOT NULL,subject_type text NOT NULL,subject_id text NOT NULL,before_json text,after_json text,request_id text,trace_id text,error_code text,created_at timestamptz NOT NULL DEFAULT now())");
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  if (originalEncryptionKey === undefined) delete process.env.LLM_PROFILE_ENCRYPTION_KEY;
  else process.env.LLM_PROFILE_ENCRYPTION_KEY = originalEncryptionKey;
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE agent_role_bindings, runtime_explanation_bindings, llm_profiles CASCADE");
});

test("keeps optional runtime explanation bindings separate from research roles", async () => {
  const profile = await saveLlmProfile(pool, {
    actorUserId: "admin-a",
    input: {
      name: "运行解释模型",
      providerName: "Private Runtime Provider",
      baseUrl: "https://runtime-llm.example.com/v1",
      modelName: "runtime-explainer-1",
      apiKey: "sk-runtime-secret",
      enabled: true,
    },
  });
  await bindRuntimeExplanationRole(pool, {
    actorUserId: "admin-a",
    role: "risk_explanation",
    profileId: profile.id,
  });

  const researchBindings = await listAgentRoleBindings(pool, { visibility: "administrator" });
  const customerBindings = await listRuntimeExplanationBindings(pool, { visibility: "customer" });
  const resolved = await resolveRuntimeExplanationRoleConfig(pool, "risk_explanation");

  assert.equal(researchBindings.length, 0);
  assert.deepEqual(customerBindings, [{
    role: "risk_explanation",
    modelName: "runtime-explainer-1",
    enabled: true,
    configured: true,
  }]);
  assert.equal(resolved.apiKey, "sk-runtime-secret");
  assert.equal(JSON.stringify(customerBindings).includes("Private Runtime Provider"), false);
  assert.equal(JSON.stringify(customerBindings).includes("runtime-llm.example.com"), false);
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

test("creates immutable profile revisions and resolves a task-pinned revision", async () => {
  const original = await saveLlmProfile(pool, {
    actorUserId: "admin-a",
    input: {
      name: "修订模型",
      providerName: "Provider",
      baseUrl: "https://llm.example.com/v1",
      modelName: "model-v1",
      apiKey: "sk-revision-one",
      enabled: true,
    },
  });
  await bindAgentRole(pool, { actorUserId: "admin-a", role: "requirements", profileId: original.id });
  const before = await snapshotAgentRoleBindings(pool);
  const pinned = before.roles.requirements;

  await saveLlmProfile(pool, {
    id: original.id,
    actorUserId: "admin-b",
    input: {
      name: "修订模型",
      providerName: "Provider",
      baseUrl: "https://llm.example.com/v1/responses",
      modelName: "model-v2",
      apiKey: "sk-revision-two",
      enabled: true,
    },
  });

  const revisions = await pool.query("SELECT revision_number, model_name FROM llm_profile_revisions WHERE profile_id = $1 ORDER BY revision_number", [original.id]);
  const current = await resolveAgentRoleConfig(pool, "requirements");
  const historical = await resolveAgentRoleConfig(pool, "requirements", { revisionId: pinned.revisionId });

  assert.deepEqual(revisions.rows, [
    { revision_number: 1, model_name: "model-v1" },
    { revision_number: 2, model_name: "model-v2" },
  ]);
  assert.equal(current.modelName, "model-v2");
  assert.equal(historical.modelName, "model-v1");
  assert.equal(historical.apiKey, "sk-revision-one");
  assert.equal(JSON.stringify(before).includes("Provider"), false);
  assert.equal(JSON.stringify(before).includes("sk-revision"), false);
});

test("safe profile edits retain hidden endpoint and key when rotation fields are blank", async () => {
  const original = await saveLlmProfile(pool, {
    actorUserId: "admin-a",
    input: { name: "安全编辑", providerName: "Provider", baseUrl: "https://llm.example.com/v1", modelName: "model-v1", apiKey: "sk-hidden-key", enabled: true },
  });
  await bindAgentRole(pool, { actorUserId: "admin-a", role: "requirements", profileId: original.id });
  await saveLlmProfile(pool, {
    id: original.id,
    actorUserId: "admin-b",
    input: { name: "安全编辑二版", providerName: "Provider", baseUrl: "", modelName: "model-v2", apiKey: "", enabled: false },
  });
  const revisions = await pool.query("SELECT base_url,encrypted_api_key FROM llm_profile_revisions WHERE profile_id=$1 ORDER BY revision_number", [original.id]);
  assert.equal(revisions.rows[1].base_url, "https://llm.example.com/v1");
  assert.equal(revisions.rows[1].encrypted_api_key, revisions.rows[0].encrypted_api_key);
  assert.notEqual(revisions.rows[1].encrypted_api_key, "sk-hidden-key");
});

test("lists redacted model revisions and rolls back by cloning a new immutable revision", async () => {
  const original = await saveLlmProfile(pool, {
    actorUserId: "admin-a",
    input: { name: "可回滚模型", providerName: "Provider", baseUrl: "https://llm.example.com/v1", modelName: "model-v1", apiKey: "sk-revision-one", enabled: true },
  });
  await bindAgentRole(pool, { actorUserId: "admin-a", role: "requirements", profileId: original.id });
  const revisionOne = original.currentRevisionId;
  const updated = await saveLlmProfile(pool, {
    id: original.id,
    actorUserId: "admin-b",
    input: { name: "可回滚模型", providerName: "Provider", baseUrl: "https://llm.example.com/v1/responses", modelName: "model-v2", apiKey: "sk-revision-two", enabled: true },
  });
  const safeHistory = await listLlmProfileRevisions(pool, original.id);
  assert.equal(safeHistory.length, 2);
  assert.equal(safeHistory[0].isCurrent, true);
  assert.equal(JSON.stringify(safeHistory).includes("llm.example.com"), false);
  assert.equal(JSON.stringify(safeHistory).includes("sk-revision"), false);

  const rollback = await rollbackLlmProfileRevision(pool, {
    profileId: original.id,
    revisionId: revisionOne,
    expectedCurrentRevisionId: updated.currentRevisionId,
    actorUserId: "admin-c",
    reason: "回退供应商不兼容修订",
  });
  const current = await resolveAgentRoleConfig(pool, "requirements");
  assert.equal(rollback.revisionNumber, 3);
  assert.equal(current.modelName, "model-v1");
  assert.equal(current.apiKey, "sk-revision-one");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM llm_profile_revisions WHERE profile_id=$1", [original.id])).rows[0].count, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE action='maintenance.llm_profile_rolled_back'", [])).rows[0].count, 1);
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

test("tests a bound role without exposing its key and rejects private DNS resolution", async () => {
  const profile = await saveLlmProfile(pool, {
    actorUserId: "admin-a",
    input: {
      name: "测试模型",
      providerName: "Provider",
      baseUrl: "https://llm.example.com/v1/responses",
      modelName: "model-safe",
      apiKey: "sk-test-connection-secret",
      enabled: true,
    },
  });
  await bindAgentRole(pool, {
    actorUserId: "admin-a",
    role: "report",
    profileId: profile.id,
  });
  let authorization = "";
  const result = await testAgentRoleConnection(pool, {
    role: "report",
    resolver: async () => [{ address: "203.0.114.5" }],
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init.headers).get("authorization") || "";
      return new Response(JSON.stringify({ output: [] }), { status: 200 });
    },
  });
  assert.equal(result.modelName, "model-safe");
  assert.equal(authorization, "Bearer sk-test-connection-secret");
  assert.equal(JSON.stringify(result).includes("secret"), false);

  await assert.rejects(
    testAgentRoleConnection(pool, {
      role: "report",
      resolver: async () => [{ address: "10.0.0.8" }],
      fetchImpl: async () => new Response(null, { status: 200 }),
    }),
    /内网/,
  );
});
