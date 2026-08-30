import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { configurationFingerprint } from "../packages/ai-control-plane/src/index.ts";

import {
  getAiControlPlaneSnapshot,
  synchronizeLegacyBinding,
  synchronizeLegacyProfile,
} from "../lib/ai-control-plane-repository.ts";
import {
  claimSecretCommand,
  completeSecretCommand,
} from "../lib/ai-secret-broker-repository.ts";
import { createAgentNovasAiGateway } from "../lib/agentnovas-ai-gateway.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `ai_control_plane_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

async function migration(name) {
  return readFile(new URL(`../postgres/migrations/${name}`, import.meta.url), "utf8");
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(await migration("0001_strategy_research.sql"));
  await pool.query(`
    INSERT INTO llm_profiles(
      id,name,provider_name,base_url,model_name,encrypted_api_key,masked_api_key,enabled,
      current_revision_id,created_by_user_id,updated_by_user_id
    ) VALUES(
      'legacy-profile','Legacy model','Legacy Provider','https://provider.quality.invalid/v1','legacy-model',
      'encrypted-legacy-key','sk-l…-key',true,'legacy-revision','maker','maker'
    )
  `);
  await pool.query(`
    INSERT INTO llm_profile_revisions(
      id,profile_id,revision_number,name,provider_name,base_url,model_name,encrypted_api_key,
      masked_api_key,enabled,created_by_user_id
    ) VALUES(
      'legacy-revision','legacy-profile',1,'Legacy model','Legacy Provider',
      'https://provider.quality.invalid/v1','legacy-model','encrypted-legacy-key','sk-l…-key',true,'maker'
    )
  `);
  await pool.query(`
    INSERT INTO agent_role_bindings(id,role,llm_profile_id,enabled,updated_by_user_id) VALUES
      ('binding-report','report','legacy-profile',true,'maker'),
      ('binding-proposal','proposal_a','legacy-profile',true,'maker')
  `);
  await pool.query(`
    INSERT INTO runtime_explanation_bindings(id,role,llm_profile_id,enabled,updated_by_user_id)
    VALUES('binding-runtime','risk_explanation','legacy-profile',false,'maker')
  `);

  const migration93 = await migration("0093_ai_control_plane.sql");
  const migration94 = await migration("0094_ai_secret_custody.sql");
  await pool.query(migration93);
  await pool.query(migration94);
  await pool.query(migration93);
  await pool.query(migration94);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("re-runnable migration preserves deployment and revision IDs while separating connections", async () => {
  const deployment = (await pool.query(`
    SELECT deployment.id,deployment.current_revision_id,deployment.enabled,
           revision.legacy_profile_revision_id,connection.secret_ref,connection.secret_fingerprint
    FROM ai_model_deployments AS deployment
    JOIN ai_deployment_revisions AS revision ON revision.id=deployment.current_revision_id
    JOIN ai_connection_revisions AS connection ON connection.id=revision.connection_revision_id
    WHERE deployment.legacy_profile_id='legacy-profile'
  `)).rows[0];

  assert.deepEqual(deployment, {
    id: "legacy-profile",
    current_revision_id: "legacy-revision",
    enabled: false,
    legacy_profile_revision_id: "legacy-revision",
    secret_ref: null,
    secret_fingerprint: "c56dfd03d49756e7e73606cb12598da6",
  });
  assert.equal((await pool.query("SELECT encrypted_api_key FROM llm_profiles WHERE id='legacy-profile'" )).rows[0].encrypted_api_key, "encrypted-legacy-key");
  const sensitiveColumns = await pool.query(`
    SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema=$1 AND table_name LIKE 'ai_%'
      AND column_name IN ('encrypted_api_key','plaintext_api_key','decrypted_api_key','private_key_pem')
  `, [schema]);
  assert.deepEqual(sensitiveColumns.rows, []);
});

test("migration materializes all twelve roles and explicit client bindings", async () => {
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM ai_control_plane_roles")).rows[0].count, 12);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM ai_binding_policies")).rows[0].count, 12);

  const targets = (await pool.query(`
    SELECT policy.role,target.deployment_revision_id,policy.enabled
    FROM ai_binding_policies AS policy
    LEFT JOIN ai_binding_targets AS target ON target.binding_policy_revision_id=policy.current_revision_id
    WHERE policy.role IN ('report','proposal_a','assistant_message','strategy_generation','risk_explanation')
    ORDER BY policy.role
  `)).rows;
  assert.deepEqual(targets, [
    { role: "assistant_message", deployment_revision_id: "legacy-revision", enabled: true },
    { role: "proposal_a", deployment_revision_id: "legacy-revision", enabled: true },
    { role: "report", deployment_revision_id: "legacy-revision", enabled: true },
    { role: "risk_explanation", deployment_revision_id: "legacy-revision", enabled: false },
    { role: "strategy_generation", deployment_revision_id: "legacy-revision", enabled: true },
  ]);
});

test("repository returns a reusable redacted snapshot", async () => {
  const snapshot = await getAiControlPlaneSnapshot(pool);
  assert.equal(snapshot.connections.length, 1);
  assert.equal(snapshot.deployments.length, 1);
  assert.equal(snapshot.bindings.length, 12);
  assert.equal(snapshot.bindings.find((binding) => binding.roleKey === "client.assistant_message")?.targets[0]?.deploymentId, "legacy-profile");
  assert.equal(snapshot.bindings.find((binding) => binding.roleKey === "runtime.risk_explanation")?.enabled, false);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("encrypted-legacy-key"), false);
  assert.equal(serialized.includes("provider.quality.invalid"), false);
});

test("legacy compatibility facade mirrors new immutable revisions and explicit client roles", async () => {
  await pool.query(`
    INSERT INTO llm_profile_revisions(
      id,profile_id,revision_number,name,provider_name,base_url,model_name,encrypted_api_key,
      masked_api_key,enabled,created_by_user_id
    ) VALUES(
      'legacy-revision-2','legacy-profile',2,'Legacy model','Legacy Provider',
      'https://provider.quality.invalid/v1','legacy-model-2','encrypted-legacy-key-2','sk-l…key2',true,'maker'
    )
  `);
  await pool.query("UPDATE llm_profiles SET current_revision_id='legacy-revision-2',model_name='legacy-model-2' WHERE id='legacy-profile'");
  await synchronizeLegacyProfile(pool, "legacy-profile");
  await pool.query("UPDATE agent_role_bindings SET updated_at=now() WHERE role='report'");
  await synchronizeLegacyBinding(pool, "assistant_message");

  const mirrored = (await pool.query(`
    SELECT deployment.current_revision_id,revision.model_id,connection.secret_ref
    FROM ai_model_deployments AS deployment
    JOIN ai_deployment_revisions AS revision ON revision.id=deployment.current_revision_id
    JOIN ai_connection_revisions AS connection ON connection.id=revision.connection_revision_id
    WHERE deployment.id='legacy-profile'
  `)).rows[0];
  assert.deepEqual(mirrored, {
    current_revision_id: "legacy-revision-2",
    model_id: "legacy-model-2",
    secret_ref: null,
  });
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM ai_binding_policy_revisions
    WHERE binding_policy_id='binding:assistant_message'
  `)).rows[0].count, 2);
});

test("safe views exclude secret, endpoint, content, identity and provider receipt columns", async () => {
  const columns = (await pool.query(`
    SELECT table_name,array_agg(column_name ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    WHERE table_schema=$1 AND table_name IN (
      'maintenance_ai_control_plane_snapshot_safe','maintenance_ai_usage_events_v2_safe'
    )
    GROUP BY table_name ORDER BY table_name
  `, [schema])).rows;
  const columnNames = columns.flatMap((row) => row.columns);
  for (const forbidden of ["endpoint", "secret_ref", "prompt", "response_content", "provider_request_id", "user_id"]) {
    assert.equal(columnNames.includes(forbidden), false, forbidden);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM maintenance_ai_control_plane_snapshot_safe")).rows[0].count >= 12, true);
});

test("binding targets enforce one primary and two fallback positions", async () => {
  await assert.rejects(
    pool.query(`
      INSERT INTO ai_binding_targets(binding_policy_revision_id,target_rank,deployment_revision_id)
      VALUES('binding-revision:report:1',3,'legacy-revision')
    `),
    (error) => error?.code === "23514",
  );
});

test("successful secret commands must erase their encrypted envelope", async () => {
  await pool.query(`
    INSERT INTO ai_secret_broker_keys(
      key_id,public_key_spki_base64,fingerprint_sha256,status,not_before
    ) VALUES('broker-key','test-public-key','${"a".repeat(64)}','active',now())
  `);
  await assert.rejects(
    pool.query(`
      INSERT INTO ai_secret_commands(
        id,target_connection_revision_id,broker_key_id,wrapped_data_key,iv,ciphertext,auth_tag,
        envelope_digest_sha256,status,requested_by_user_id,idempotency_key,secret_ref,secret_fingerprint,completed_at
      ) VALUES(
        'invalid-success','legacy-connection-revision:legacy-revision','broker-key','wrapped','iv','cipher','tag',
        '${"b".repeat(64)}','succeeded','maker','invalid-success','managed://connection/revision','${"c".repeat(16)}',now()
      )
    `),
    (error) => error?.code === "23514",
  );
});

test("Broker claim and fenced completion atomically replace ciphertext with a managed reference", async () => {
  await pool.query(`
    INSERT INTO ai_secret_commands(
      id,target_connection_revision_id,broker_key_id,wrapped_data_key,iv,ciphertext,auth_tag,
      envelope_digest_sha256,requested_by_user_id,idempotency_key
    ) VALUES(
      'broker-command','legacy-connection-revision:legacy-revision','broker-key','d3JhcHBlZA==',
      'aXYxMjM0NTY3ODkw','Y2lwaGVydGV4dA==','dGFnMTIzNDU2Nzg5MDEyMw==',
      '${"d".repeat(64)}','maker','broker-command-key'
    )
  `);
  const claimed = await claimSecretCommand(pool,{ brokerInstanceId: "broker-instance" });
  assert.equal(claimed.command.commandId,"broker-command");
  await assert.rejects(
    completeSecretCommand(pool,{
      brokerInstanceId: "broker-instance",
      fencingToken: String(Number(claimed.fencingToken) + 1),
      receipt: {
        commandId: "broker-command",
        targetConnectionRevisionId: "legacy-connection-revision:legacy-revision",
        brokerKeyId: "broker-key",
        envelopeDigestSha256: "d".repeat(64),
        secretRef: `managed://ai/${"e".repeat(64)}.secret`,
        secretFingerprint: "f".repeat(64),
        fileMode: "0600",
        directoryMode: "0700",
        brokerInstanceId: "broker-instance",
        completedAt: new Date().toISOString(),
      },
    }),
    (error) => error?.code === "AI_SECRET_COMMAND_FENCE_MISMATCH",
  );
  const receipt = {
    commandId: "broker-command",
    targetConnectionRevisionId: "legacy-connection-revision:legacy-revision",
    brokerKeyId: "broker-key",
    envelopeDigestSha256: "d".repeat(64),
    secretRef: `managed://ai/${"e".repeat(64)}.secret`,
    secretFingerprint: "f".repeat(64),
    fileMode: "0600",
    directoryMode: "0700",
    brokerInstanceId: "broker-instance",
    completedAt: new Date().toISOString(),
  };
  await completeSecretCommand(pool,{
    brokerInstanceId: "broker-instance",
    fencingToken: claimed.fencingToken,
    receipt,
  });
  const completed = (await pool.query(`
    SELECT status,wrapped_data_key,ciphertext,secret_ref FROM ai_secret_commands WHERE id='broker-command'
  `)).rows[0];
  assert.deepEqual(completed,{
    status: "succeeded",
    wrapped_data_key: null,
    ciphertext: null,
    secret_ref: receipt.secretRef,
  });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM ai_secret_receipts WHERE command_id='broker-command'")).rows[0].count,1);
});

test("Gateway completes a Fake Provider invocation, records unified usage and replays idempotently", async () => {
  const deployment = (await pool.query(`
    SELECT deployment.id,deployment.config_fingerprint,connection.id AS connection_revision_id,
           connection.connection_id
    FROM ai_deployment_revisions AS deployment
    JOIN ai_connection_revisions AS connection ON connection.id=deployment.connection_revision_id
    WHERE deployment.id='legacy-revision-2'
  `)).rows[0];
  const secretRef = `managed://ai/${"1".repeat(64)}.secret`;
  await pool.query("UPDATE ai_provider_connections SET enabled=true WHERE id=$1",[deployment.connection_id]);
  await pool.query("UPDATE ai_model_deployments SET enabled=true WHERE id='legacy-profile'");
  await pool.query("UPDATE ai_connection_revisions SET secret_ref=$2,secret_fingerprint=$3 WHERE id=$1",[
    deployment.connection_revision_id,secretRef,"2".repeat(64),
  ]);
  await pool.query("UPDATE ai_binding_policies SET enabled=true WHERE role='assistant_message'");
  await pool.query(`
    INSERT INTO ai_probe_receipts(
      id,connection_revision_id,deployment_revision_id,config_fingerprint,phase,status,
      latency_ms,requested_by_user_id,completed_at
    ) VALUES('probe-gateway',$1,'legacy-revision-2',$2,'invocation','succeeded',12,'maker',now())
  `,[deployment.connection_revision_id,deployment.config_fingerprint]);

  let calls = 0;
  const providerAdapter = {
    id: "fake-provider",
    async discoverModels() { return ["legacy-model-2"]; },
    async probe() { throw new Error("not used"); },
    async invoke(invocation) {
      calls += 1;
      assert.equal(invocation.apiKey,"fake-provider-key");
      return { content: "fake provider answer",usage: { inputTokens: 9,outputTokens: 4 } };
    },
    classifyError(error) { return error; },
  };
  const gateway = createAgentNovasAiGateway({
    pool,
    secretStore: {
      async has(reference) { return reference === secretRef; },
      async read(reference) {
        assert.equal(reference,secretRef);
        return "fake-provider-key";
      },
    },
    providerAdapter,
  });
  const payload = { messages: [{ role: "user",content: "quality request" }] };
  const requestHash = await configurationFingerprint({
    roleKey: "client.assistant_message",operation: "assistant_message",payload,
  });
  const request = {
    invocationId: "gateway-invocation",
    requestHash,
    roleKey: "client.assistant_message",
    operation: "assistant_message",
    trafficKind: "business",
    payload,
  };
  const result = await gateway.invoke(request);
  assert.equal(result.content,"fake provider answer");
  assert.equal(result.receipt.status,"succeeded");
  assert.equal("secretRef" in result.receipt.selectedCandidate,false);
  assert.equal(calls,1);
  assert.deepEqual((await pool.query(`
    SELECT event_kind FROM ai_usage_events WHERE invocation_id='gateway-invocation' ORDER BY event_sequence
  `)).rows.map(row => row.event_kind),["requested","attempted","succeeded"]);

  const replay = await gateway.invoke(request);
  assert.equal(replay.content,"fake provider answer");
  assert.equal(calls,1);
  const otherPayload = { messages: [{ role: "user",content: "different request" }] };
  await assert.rejects(gateway.invoke({
    ...request,
    payload: otherPayload,
    requestHash: await configurationFingerprint({
      roleKey: request.roleKey,operation: request.operation,payload: otherPayload,
    }),
  }),(error) => error?.code === "AI_INVOCATION_IDEMPOTENCY_CONFLICT");
});
