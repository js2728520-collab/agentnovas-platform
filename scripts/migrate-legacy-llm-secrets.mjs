import { createHash } from "node:crypto";

import pg from "pg";

import { createSecretEnvelope } from "@agentnovas/ai-control-plane";

import { decryptLlmProfileSecret } from "../lib/integration-credentials.ts";

if (process.env.ALLOW_LEGACY_LLM_SECRET_MIGRATION !== "true") {
  throw new Error("ALLOW_LEGACY_LLM_SECRET_MIGRATION must be true");
}
const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const databaseRole = decodeURIComponent(new URL(databaseUrl).username);
if (databaseRole !== "agentnovas_migrator") throw new Error("Legacy migration requires agentnovas_migrator");
if ((process.env.LLM_PROFILE_ENCRYPTION_KEY?.trim().length ?? 0) < 32) {
  throw new Error("LLM_PROFILE_ENCRYPTION_KEY is required only for this offline migration");
}

const pool = new pg.Pool({ connectionString: databaseUrl,max: 1,application_name: "agentnovas-legacy-llm-secret-migration" });
let queued = 0;
let skipped = 0;
try {
  const brokerKey = (await pool.query(`
    SELECT key_id,public_key_spki_base64 FROM ai_secret_broker_keys
    WHERE status='active' AND not_before <= now() AND (not_after IS NULL OR not_after > now())
  `)).rows[0];
  if (!brokerKey) throw new Error("No active AI Secret Broker public key is registered");
  const revisions = (await pool.query(`
    SELECT legacy.id AS legacy_revision_id,legacy.encrypted_api_key,connection.id AS connection_revision_id
    FROM llm_profile_revisions AS legacy
    JOIN ai_connection_revisions AS connection ON connection.legacy_profile_revision_id=legacy.id
    LEFT JOIN ai_legacy_secret_migration_receipts AS receipt ON receipt.legacy_profile_revision_id=legacy.id
    WHERE connection.secret_ref IS NULL AND receipt.id IS NULL
    ORDER BY legacy.profile_id,legacy.revision_number
  `)).rows;
  for (const revision of revisions) {
    const digest = createHash("sha256").update(revision.legacy_revision_id).digest("hex");
    const commandId = `legacy-secret:${digest.slice(0,48)}`;
    const existing = await pool.query("SELECT 1 FROM ai_secret_commands WHERE id=$1",[commandId]);
    if (existing.rows[0]) {
      skipped += 1;
      continue;
    }
    const secret = await decryptLlmProfileSecret(revision.encrypted_api_key);
    const envelope = await createSecretEnvelope({
      commandId,
      targetConnectionRevisionId: revision.connection_revision_id,
      brokerKeyId: brokerKey.key_id,
      publicKeySpkiBase64: brokerKey.public_key_spki_base64,
      secret,
    });
    await pool.query(`
      INSERT INTO ai_secret_commands(
        id,target_connection_revision_id,broker_key_id,algorithm,wrapped_data_key,iv,ciphertext,
        auth_tag,envelope_digest_sha256,requested_by_user_id,idempotency_key
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'offline-legacy-migrator',$10)
      ON CONFLICT(requested_by_user_id,idempotency_key) DO NOTHING
    `,[
      envelope.commandId,envelope.targetConnectionRevisionId,envelope.brokerKeyId,envelope.algorithm,
      envelope.wrappedDataKey,envelope.iv,envelope.ciphertext,envelope.authTag,
      envelope.envelopeDigestSha256,`legacy:${revision.legacy_revision_id}`,
    ]);
    queued += 1;
  }
  const evidence = (await pool.query(`
    SELECT status,count(*)::int AS count FROM ai_legacy_secret_migration_receipts GROUP BY status ORDER BY status
  `)).rows;
  process.stdout.write(`${JSON.stringify({ queued,skipped,evidence })}\n`);
} finally {
  await pool.end();
}
