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
  // 0093 is a late-chain migration. This focused fixture models only the audit
  // columns its transactional configuration functions depend on.
  await pool.query(`
    CREATE TABLE audit_logs(
      id text PRIMARY KEY,actor_user_id text,action text NOT NULL,subject_type text NOT NULL,
      subject_id text NOT NULL,after_json text,request_id text,created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE client_ai_inference_requests(
      id text PRIMARY KEY,user_id text NOT NULL,organization_id text
    )
  `);
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

test("configuration, custody command and binding revisions commit through audited database functions", async () => {
  await pool.query(`
    INSERT INTO ai_secret_broker_keys(
      key_id,public_key_spki_base64,fingerprint_sha256,status,not_before
    ) VALUES('broker-key','test-public-key',$1,'active',now())
    ON CONFLICT(key_id) DO NOTHING
  `,["a".repeat(64)]);
  const saved = (await pool.query(`
    SELECT ai_save_connection_deployment_with_rate_card(
      'connection-managed','connection-managed-r1','Managed Provider','https://managed.quality.invalid/v1',
      'deployment-managed','deployment-managed-r1','Managed model','managed-model',32768,2048,true,true,
      'rate-managed-r1','USD','2.5','7.5','1.25',
      'maker','configure managed model','request-config-managed'
    ) AS value
  `)).rows[0].value;
  assert.equal(saved.connectionRevisionId,"connection-managed-r1");
  assert.equal(saved.deploymentRevisionId,"deployment-managed-r1");
  assert.equal(saved.rateCardRevisionId,"rate-managed-r1");

  const command = (await pool.query(`
    SELECT ai_enqueue_secret_command(
      'command-managed','connection-managed-r1','broker-key','AES-256-GCM+RSA-OAEP-SHA256',
      'd3JhcHBlZA==','aXYxMjM0NTY3ODkw','Y2lwaGVydGV4dA==','dGFnMTIzNDU2Nzg5MDEyMw==',
      $1,'maker','managed-secret','install managed secret','request-secret-managed'
    ) AS id
  `,["9".repeat(64)])).rows[0].id;
  assert.equal(command,"command-managed");

  const claimed = await claimSecretCommand(pool,{ brokerInstanceId: "broker-managed" });
  assert.equal(claimed.command.commandId,"command-managed");
  await completeSecretCommand(pool,{
    brokerInstanceId: "broker-managed",
    fencingToken: claimed.fencingToken,
    receipt: {
      commandId: "command-managed",
      targetConnectionRevisionId: "connection-managed-r1",
      brokerKeyId: "broker-key",
      envelopeDigestSha256: "9".repeat(64),
      secretRef: `managed://ai/${"8".repeat(64)}.secret`,
      secretFingerprint: "7".repeat(64),
      fileMode: "0600",
      directoryMode: "0700",
      brokerInstanceId: "broker-managed",
      completedAt: new Date().toISOString(),
    },
  });
  const fingerprint = (await pool.query(
    "SELECT config_fingerprint FROM ai_deployment_revisions WHERE id='deployment-managed-r1'",
  )).rows[0].config_fingerprint;
  assert.notEqual(fingerprint,saved.configurationFingerprint,"installing a secret must invalidate earlier configuration fingerprints");
  await pool.query(`
    INSERT INTO ai_probe_receipts(
      id,connection_revision_id,deployment_revision_id,config_fingerprint,phase,status,
      latency_ms,requested_by_user_id,completed_at
    ) VALUES('probe-managed','connection-managed-r1','deployment-managed-r1',$1,'invocation','succeeded',7,'maker',now())
  `,[fingerprint]);
  const revisionId = (await pool.query(`
    SELECT ai_update_binding_policy(
      'market_summary','binding-managed-r1',ARRAY['deployment-managed-r1'],true,
      'maker','activate runtime summary','request-binding-managed'
    ) AS id
  `)).rows[0].id;
  assert.equal(revisionId,"binding-managed-r1");
  assert.equal((await pool.query("SELECT enabled FROM ai_binding_policies WHERE role='market_summary'")).rows[0].enabled,true);
  await pool.query(`
    INSERT INTO ai_probe_receipts(
      id,connection_revision_id,deployment_revision_id,config_fingerprint,phase,status,
      error_class,requested_by_user_id,requested_at,completed_at
    ) VALUES(
      'probe-managed-latest-failure','connection-managed-r1','deployment-managed-r1',$1,
      'invocation','failed','network','maker',now()+interval '1 second',now()
    )
  `,[fingerprint]);
  await assert.rejects(pool.query(`
    SELECT ai_update_binding_policy(
      'risk_explanation','binding-managed-failed-probe',ARRAY['deployment-managed-r1'],true,
      'maker','reject latest failed probe','request-binding-failed-probe'
    )
  `),(error) => error?.code === "23514");

  const auditActions = (await pool.query(`
    SELECT action FROM audit_logs
    WHERE request_id IN ('request-config-managed','request-secret-managed','request-binding-managed')
    ORDER BY action
  `)).rows.map((row) => row.action);
  assert.deepEqual(auditActions,[
    "maintenance.ai_control_plane.binding_updated",
    "maintenance.ai_control_plane.configuration_saved",
    "maintenance.ai_control_plane.rate_card_created",
    "maintenance.ai_control_plane.secret_enqueued",
  ]);
});

test("successful secret commands must erase their encrypted envelope", async () => {
  await pool.query(`
    INSERT INTO ai_secret_broker_keys(
      key_id,public_key_spki_base64,fingerprint_sha256,status,not_before
    ) VALUES('broker-key','test-public-key','${"a".repeat(64)}','active',now())
    ON CONFLICT(key_id) DO NOTHING
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

test("deployment revisions serialize concurrent configuration writes and rollback by creating a new immutable revision", async () => {
  const save = (connectionRevisionId,deploymentRevisionId,requestId) => pool.query(`
    SELECT ai_save_connection_deployment_with_rate_card(
      'connection-concurrent',$1,'Concurrent Provider','https://concurrent.quality.invalid/v1',
      'deployment-concurrent',$2,'Concurrent model','concurrent-model',16384,1024,true,false,
      NULL,NULL,NULL,NULL,NULL,'maker','serialize concurrent revisions',$3
    ) AS value
  `,[connectionRevisionId,deploymentRevisionId,requestId]);
  await Promise.all([
    save("connection-concurrent-r1","deployment-concurrent-r1","request-concurrent-r1"),
    save("connection-concurrent-r2","deployment-concurrent-r2","request-concurrent-r2"),
  ]);
  assert.deepEqual((await pool.query(`
    SELECT revision_number FROM ai_deployment_revisions
    WHERE deployment_id='deployment-concurrent' ORDER BY revision_number
  `)).rows.map(row => row.revision_number),[1,2]);

  const second = (await pool.query(`
    SELECT ai_save_connection_deployment_with_rate_card(
      'connection-managed','connection-managed-r2','Managed Provider','https://managed.quality.invalid/v1',
      'deployment-managed','deployment-managed-r2','Managed model','managed-model-v2',32768,2048,true,true,
      NULL,NULL,NULL,NULL,NULL,'maker','create second managed revision','request-config-managed-r2'
    ) AS value
  `)).rows[0].value;
  assert.equal(second.deploymentRevisionId,"deployment-managed-r2");
  const rollback = (await pool.query(`
    SELECT ai_rollback_deployment(
      'deployment-managed','deployment-managed-r1','deployment-managed-r2','deployment-managed-r3',
      'maker','restore first managed revision','request-rollback-managed'
    ) AS value
  `)).rows[0].value;
  assert.equal(rollback.deploymentRevisionId,"deployment-managed-r3");
  assert.equal(rollback.revisionNumber,3);
  assert.deepEqual((await pool.query(`
    SELECT revision.model_id,revision.rate_card_revision_id,deployment.current_revision_id,deployment.enabled
    FROM ai_model_deployments AS deployment
    JOIN ai_deployment_revisions AS revision ON revision.id=deployment.current_revision_id
    WHERE deployment.id='deployment-managed'
  `)).rows[0],{
    model_id: "managed-model",rate_card_revision_id: "rate-managed-r1",
    current_revision_id: "deployment-managed-r3",enabled: false,
  });
  await assert.rejects(pool.query(`
    SELECT ai_rollback_deployment(
      'deployment-managed','deployment-managed-r1','deployment-managed-r2','deployment-managed-r4',
      'maker','reject stale rollback request','request-rollback-stale'
    )
  `),(error) => error?.code === "40001");
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
  await pool.query("UPDATE ai_secret_commands SET lease_expires_at=now()-interval '1 second' WHERE id='broker-command'");
  const reclaimed = await claimSecretCommand(pool,{ brokerInstanceId: "broker-recovery" });
  assert.equal(reclaimed.command.commandId,"broker-command");
  assert.notEqual(reclaimed.fencingToken,claimed.fencingToken);
  await assert.rejects(
    completeSecretCommand(pool,{
      brokerInstanceId: "broker-instance",
      fencingToken: claimed.fencingToken,
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
    brokerInstanceId: "broker-recovery",
    completedAt: new Date().toISOString(),
  };
  await completeSecretCommand(pool,{
    brokerInstanceId: "broker-recovery",
    fencingToken: reclaimed.fencingToken,
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
    INSERT INTO ai_rate_card_revisions(
      id,deployment_id,revision_number,currency,input_cost_per_million,output_cost_per_million,
      cached_input_cost_per_million,effective_from,created_by_user_id
    ) VALUES('rate-gateway','legacy-profile',1,'USD',2,4,1,now(),'maker')
  `);
  await pool.query("UPDATE ai_deployment_revisions SET rate_card_revision_id='rate-gateway' WHERE id='legacy-revision-2'");
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
    async probe() { return { content: "OK",usage: { inputTokens: 2,outputTokens: 1 } }; },
    async invoke(invocation) {
      calls += 1;
      assert.equal(invocation.apiKey,"fake-provider-key");
      return {
        content: "fake provider answer",usage: { inputTokens: 9,outputTokens: 4 },
        providerRequestId: "provider-sensitive-receipt",
      };
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
  await pool.query(`
    INSERT INTO client_ai_inference_requests(id,user_id,organization_id)
    VALUES('gateway-invocation','sensitive-user-id','organization-snapshot')
  `);
  await pool.query(`SELECT ai_upsert_budget_policy(
    'budget-one-request','platform','platform','month','1','requests',true,
    'maker','observe request threshold','request-budget-one'
  )`);
  const result = await gateway.invoke(request);
  assert.equal(result.content,"fake provider answer");
  assert.equal(result.receipt.status,"succeeded");
  assert.equal(result.receipt.providerRequestId,"provider-sensitive-receipt");
  assert.equal("secretRef" in result.receipt.selectedCandidate,false);
  const providerReceiptHash = (await pool.query(`
    SELECT provider_request_id_hash FROM ai_invocation_receipts WHERE invocation_id='gateway-invocation'
  `)).rows[0].provider_request_id_hash;
  assert.match(providerReceiptHash,/^[a-f0-9]{64}$/);
  assert.notEqual(providerReceiptHash,"provider-sensitive-receipt");
  assert.equal(calls,1);
  assert.deepEqual((await pool.query(`
    SELECT event_kind FROM ai_usage_events WHERE invocation_id='gateway-invocation' ORDER BY event_sequence
  `)).rows.map(row => row.event_kind),["requested","attempted","succeeded"]);
  const attribution = (await pool.query(`
    SELECT DISTINCT pseudonymized_user_id,organization_id
    FROM maintenance_ai_usage_events_v2_safe
    WHERE deployment_revision_id='legacy-revision-2'
  `)).rows.find(row => row.organization_id === "organization-snapshot");
  assert.match(attribution.pseudonymized_user_id,/^[a-f0-9]{32}$/);
  assert.notEqual(attribution.pseudonymized_user_id,"sensitive-user-id");
  assert.deepEqual((await pool.query(`
    SELECT provider_cost_amount::text,provider_cost_currency,pricing_state
    FROM ai_usage_events WHERE invocation_id='gateway-invocation' AND event_kind='succeeded'
  `)).rows[0],{
    provider_cost_amount: "0.000034000000",provider_cost_currency: "USD",pricing_state: "priced",
  });
  await pool.query("SELECT ai_settle_invocation_credits('gateway-invocation','3')");
  assert.equal((await pool.query(`
    SELECT platform_settled_credits::text FROM ai_usage_events
    WHERE invocation_id='gateway-invocation' AND event_kind='succeeded'
  `)).rows[0].platform_settled_credits,"3");
  assert.deepEqual((await pool.query(`
    SELECT threshold_percent,observed_amount::text FROM maintenance_ai_budget_alerts_safe
    WHERE budget_policy_id='budget-one-request' ORDER BY threshold_percent
  `)).rows,[
    { threshold_percent: 80,observed_amount: "1.000000000000" },
    { threshold_percent: 100,observed_amount: "1.000000000000" },
  ]);

  await pool.query(`SELECT ai_request_probe(
    'probe-unified','legacy-revision-2','maker','verify unified probe usage','request-probe-unified'
  )`);
  const probeResult = await gateway.probe({
    probeReceiptId: "probe-unified",deploymentRevisionId: "legacy-revision-2",
  });
  assert.equal(probeResult.receipt.status,"succeeded");
  assert.deepEqual((await pool.query(`
    SELECT event_kind,consumer,input_tokens,output_tokens FROM ai_usage_events
    WHERE invocation_id='probe:' || md5('probe-unified') ORDER BY event_sequence
  `)).rows,[
    { event_kind: "requested",consumer: "probe",input_tokens: "0",output_tokens: "0" },
    { event_kind: "processing",consumer: "probe",input_tokens: "0",output_tokens: "0" },
    { event_kind: "succeeded",consumer: "probe",input_tokens: "2",output_tokens: "1" },
  ]);

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
