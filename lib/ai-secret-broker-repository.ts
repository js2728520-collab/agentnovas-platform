import type { SecretEnvelopeCommand } from "@agentnovas/ai-control-plane";
import type { Pool, QueryResultRow } from "pg";

import type { SecretBrokerReceipt } from "./ai-secret-broker.ts";

type CommandRow = QueryResultRow & {
  id: string;
  target_connection_revision_id: string;
  broker_key_id: string;
  algorithm: SecretEnvelopeCommand["algorithm"];
  wrapped_data_key: string;
  iv: string;
  ciphertext: string;
  auth_tag: string;
  envelope_digest_sha256: string;
  fencing_token: string;
};

export type ClaimedSecretCommand = {
  command: SecretEnvelopeCommand;
  fencingToken: string;
};

export async function claimSecretCommand(pool: Pool, input: {
  brokerInstanceId: string;
  leaseMs?: number;
}): Promise<ClaimedSecretCommand | null> {
  const leaseMs = Math.min(Math.max(input.leaseMs ?? 30_000,5_000),120_000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidate = (await client.query<{ id: string }>(`
      SELECT id FROM ai_secret_commands
      WHERE (
        status IN ('requested','failed')
        OR (status='processing' AND lease_expires_at < now())
      ) AND attempt_count < 5
      ORDER BY requested_at,id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `)).rows[0];
    if (!candidate) {
      await client.query("COMMIT");
      return null;
    }
    const row = (await client.query<CommandRow>(`
      UPDATE ai_secret_commands SET
        status='processing',attempt_count=attempt_count+1,lease_owner=$2,
        lease_expires_at=now()+($3::int * interval '1 millisecond'),
        fencing_token=fencing_token+1,error_code=NULL,completed_at=NULL,updated_at=now()
      WHERE id=$1
      RETURNING id,target_connection_revision_id,broker_key_id,algorithm,wrapped_data_key,
        iv,ciphertext,auth_tag,envelope_digest_sha256,fencing_token::text
    `,[candidate.id,input.brokerInstanceId,leaseMs])).rows[0];
    await client.query("COMMIT");
    return {
      command: {
        commandId: row.id,
        targetConnectionRevisionId: row.target_connection_revision_id,
        brokerKeyId: row.broker_key_id,
        algorithm: row.algorithm,
        wrappedDataKey: row.wrapped_data_key,
        iv: row.iv,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
        envelopeDigestSha256: row.envelope_digest_sha256,
      },
      fencingToken: row.fencing_token,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeSecretCommand(pool: Pool, input: {
  brokerInstanceId: string;
  fencingToken: string;
  receipt: SecretBrokerReceipt;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const command = (await client.query<{
      id: string;
      target_connection_revision_id: string;
      broker_key_id: string;
      envelope_digest_sha256: string;
    }>(`
      SELECT id,target_connection_revision_id,broker_key_id,envelope_digest_sha256
      FROM ai_secret_commands
      WHERE id=$1 AND status='processing' AND lease_owner=$2 AND fencing_token=$3::bigint
      FOR UPDATE
    `,[input.receipt.commandId,input.brokerInstanceId,input.fencingToken])).rows[0];
    if (!command
      || command.target_connection_revision_id !== input.receipt.targetConnectionRevisionId
      || command.broker_key_id !== input.receipt.brokerKeyId
      || command.envelope_digest_sha256 !== input.receipt.envelopeDigestSha256) {
      const error = new Error("AI_SECRET_COMMAND_FENCE_MISMATCH") as Error & { code: string };
      error.code = "AI_SECRET_COMMAND_FENCE_MISMATCH";
      throw error;
    }
    await client.query(`
      INSERT INTO ai_secret_receipts(
        id,command_id,target_connection_revision_id,broker_key_id,envelope_digest_sha256,
        secret_ref,secret_fingerprint,file_mode,directory_mode,broker_instance_id,completed_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(command_id) DO NOTHING
    `,[
      crypto.randomUUID(),command.id,command.target_connection_revision_id,command.broker_key_id,
      command.envelope_digest_sha256,input.receipt.secretRef,input.receipt.secretFingerprint,
      input.receipt.fileMode,input.receipt.directoryMode,input.brokerInstanceId,input.receipt.completedAt,
    ]);
    await client.query(`
      UPDATE ai_connection_revisions
      SET secret_ref=$2,secret_fingerprint=$3
      WHERE id=$1
    `,[command.target_connection_revision_id,input.receipt.secretRef,input.receipt.secretFingerprint]);
    await client.query(`
      INSERT INTO ai_legacy_secret_migration_receipts(
        id,legacy_profile_revision_id,target_connection_revision_id,status,secret_ref,secret_fingerprint
      )
      SELECT $1,connection.legacy_profile_revision_id,connection.id,'succeeded',$3,$4
      FROM ai_connection_revisions AS connection
      WHERE connection.id=$2 AND connection.legacy_profile_revision_id IS NOT NULL
      ON CONFLICT(legacy_profile_revision_id) DO UPDATE SET
        status='succeeded',secret_ref=EXCLUDED.secret_ref,secret_fingerprint=EXCLUDED.secret_fingerprint,
        error_code=NULL,migrated_at=now()
    `,[crypto.randomUUID(),command.target_connection_revision_id,input.receipt.secretRef,input.receipt.secretFingerprint]);
    await client.query(`
      UPDATE ai_secret_commands SET
        status='succeeded',wrapped_data_key=NULL,iv=NULL,ciphertext=NULL,auth_tag=NULL,
        secret_ref=$2,secret_fingerprint=$3,lease_owner=NULL,lease_expires_at=NULL,
        completed_at=$4,updated_at=now()
      WHERE id=$1
    `,[command.id,input.receipt.secretRef,input.receipt.secretFingerprint,input.receipt.completedAt]);
    await client.query("COMMIT");
    return { completed: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failSecretCommand(pool: Pool, input: {
  commandId: string;
  brokerInstanceId: string;
  fencingToken: string;
  errorCode: string;
}) {
  const errorCode = /^[A-Z0-9_]{3,80}$/.test(input.errorCode) ? input.errorCode : "AI_SECRET_BROKER_FAILED";
  const result = await pool.query(`
    UPDATE ai_secret_commands SET
      status='failed',error_code=$4,lease_owner=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()
    WHERE id=$1 AND status='processing' AND lease_owner=$2 AND fencing_token=$3::bigint
  `,[input.commandId,input.brokerInstanceId,input.fencingToken,errorCode]);
  return { failed: result.rowCount === 1 };
}
