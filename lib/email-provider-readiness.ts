import type { Pool } from "pg";

export type EmailProviderReadinessInput = {
  action: "activate" | "disable";
  evidenceReference: string;
  senderDomainVerified: boolean;
  webhookVerified: boolean;
  templatesVerified: boolean;
  suppressionEnabled: boolean;
  inboundMailboxesVerified: boolean;
};

function readinessSettings(input: EmailProviderReadinessInput) {
  const evidenceReference = input.evidenceReference.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/.test(evidenceReference)) {
    throw new Error("EMAIL_READINESS_EVIDENCE_INVALID");
  }
  const settings = {
    evidenceReference,
    inboundMailboxesVerified: input.inboundMailboxesVerified,
    senderDomainVerified: input.senderDomainVerified,
    suppressionEnabled: input.suppressionEnabled,
    templatesVerified: input.templatesVerified,
    webhookVerified: input.webhookVerified,
  };
  if (input.action === "activate" && !(
    settings.senderDomainVerified
    && settings.webhookVerified
    && settings.templatesVerified
    && settings.suppressionEnabled
  )) throw new Error("EMAIL_READINESS_INCOMPLETE");
  return settings;
}

export async function recordEmailProviderReadiness(
  pool: Pool,
  input: EmailProviderReadinessInput,
) {
  const settings = readinessSettings(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agentnovas:email-provider-readiness:v1', 0))");
    const actors = await client.query<{ id: string }>(`
      SELECT id FROM users
      WHERE role='hq_admin' AND status='active'
      ORDER BY created_at,id
      FOR UPDATE
    `);
    if (actors.rowCount !== 1) throw new Error("EMAIL_READINESS_ACTOR_NOT_UNIQUE");
    const actorUserId = actors.rows[0].id;
    const provider = await client.query<{
      id: string;
      status: string;
      sender_domain: string | null;
      settings_json: Record<string, unknown>;
    }>(`
      SELECT id,status,sender_domain,settings_json
      FROM notification_provider_configs
      WHERE provider='resend' AND channel='email'
      FOR UPDATE
    `);
    const current = provider.rows[0];
    if (!current) throw new Error("EMAIL_PROVIDER_CONFIG_NOT_FOUND");
    const status = input.action === "activate" ? "active" : "disabled";
    await client.query(`
      UPDATE notification_provider_configs
      SET status=$2,sender_domain='agentnovas.com',settings_json=$3::jsonb,
          updated_by_user_id=$4,updated_at=now()
      WHERE id=$1
    `, [current.id, status, JSON.stringify(settings), actorUserId]);
    await client.query(`
      INSERT INTO audit_logs(
        id,actor_user_id,action,subject_type,subject_id,before_json,after_json
      ) VALUES($1,$2,'system.email_provider_readiness_recorded','notification_provider_config',$3,$4,$5)
    `, [crypto.randomUUID(), actorUserId, current.id, JSON.stringify({
      status: current.status,
      senderDomainConfigured: current.sender_domain === "agentnovas.com",
      settings: {
        senderDomainVerified: current.settings_json?.senderDomainVerified === true,
        webhookVerified: current.settings_json?.webhookVerified === true,
        templatesVerified: current.settings_json?.templatesVerified === true,
        suppressionEnabled: current.settings_json?.suppressionEnabled === true,
        inboundMailboxesVerified: current.settings_json?.inboundMailboxesVerified === true,
      },
    }), JSON.stringify({ status, settings })]);
    await client.query("COMMIT");
    return { ok: true as const, status, actorUserId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
