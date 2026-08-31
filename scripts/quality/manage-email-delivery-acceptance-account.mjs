import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { Pool } from "pg";

import { hashPassword, normalizeEmail, randomToken, validEmail } from "../../lib/auth.ts";
import { encryptEmailTestRecipient } from "../../lib/email-test-recipient-crypto.ts";
import { maskEmailAddress } from "../../packages/notifications/src/email-service-management.ts";

function notificationRecipientHash(value) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

const mode = process.argv[2];
if (mode !== "--provision" && mode !== "--teardown") {
  throw new Error("usage: manage-email-delivery-acceptance-account.mjs --provision|--teardown");
}
if (process.env.ALLOW_EMAIL_DELIVERY_ACCOUNT_PROVISIONING !== "1") {
  throw new Error("set ALLOW_EMAIL_DELIVERY_ACCOUNT_PROVISIONING=1 for the test-only account lifecycle");
}
if (process.env.EMAIL_DELIVERY_TEST_SITE_HOST !== "main-test.agentnovas.com") {
  throw new Error("EMAIL_DELIVERY_TEST_SITE_HOST must be main-test.agentnovas.com");
}

const answerInput = resolve(process.env.EMAIL_DELIVERY_ALLOWLIST_FILE ?? "");
const credentialInput = resolve(process.env.EMAIL_DELIVERY_CREDENTIAL_FILE ?? "");
if (answerInput !== "/run/config/resend-test.answers") {
  throw new Error("EMAIL_DELIVERY_ALLOWLIST_FILE must be /run/config/resend-test.answers");
}
if (!credentialInput.startsWith("/run/credentials/three-app-credentials-")
  || !/^three-app-credentials-[A-Za-z0-9._-]+\.json$/.test(basename(credentialInput))) {
  throw new Error("EMAIL_DELIVERY_CREDENTIAL_FILE must be a protected /run/credentials/three-app-credentials-*.json file");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

async function protectedRegularFile(path, allowedModes) {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (!metadata.isFile() || !allowedModes.includes(metadata.mode & 0o777)) {
    throw new Error(`protected file has an invalid type or mode: ${basename(path)}`);
  }
  return canonical;
}

function parseAllowlist(contents) {
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("invalid protected answer file");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (values.has(key)) throw new Error("duplicate protected answer key");
    values.set(key, value);
  }
  const recipients = (values.get("NOTIFICATION_EMAIL_ALLOWLIST") ?? "")
    .split(",")
    .map(value => normalizeEmail(value))
    .filter(Boolean);
  if (recipients.length !== 1 || !validEmail(recipients[0])) {
    throw new Error("the test allowlist must contain exactly one valid recipient");
  }
  return recipients[0];
}

function assertUuid(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`invalid protected credential metadata: ${field}`);
  }
  return value;
}

function assertRecipientId(value) {
  if (typeof value !== "string"
    || (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      && !/^legacy-[a-f0-9]{32}$/.test(value))) {
    throw new Error("invalid protected credential metadata: recipientId");
  }
  return value;
}

async function bootstrapContext(client) {
  const actorResult = await client.query(`
    SELECT id,organization_id FROM users
    WHERE role='hq_admin' AND status='active'
    ORDER BY created_at,id FOR UPDATE
  `);
  if (actorResult.rowCount !== 1) throw new Error("EMAIL_DELIVERY_BOOTSTRAP_ADMIN_NOT_UNIQUE");
  const actor = actorResult.rows[0];
  const organizationResult = await client.query(`
    SELECT id FROM organizations
    WHERE type='headquarters' AND status='active'
    ORDER BY CASE WHEN id=$1 THEN 0 ELSE 1 END,created_at,id
    FOR SHARE
  `, [actor.organization_id]);
  if (!organizationResult.rowCount) throw new Error("EMAIL_DELIVERY_HEADQUARTERS_NOT_FOUND");
  const organizationId = organizationResult.rows.some(row => row.id === actor.organization_id)
    ? actor.organization_id
    : organizationResult.rowCount === 1 ? organizationResult.rows[0].id : null;
  if (!organizationId) throw new Error("EMAIL_DELIVERY_HEADQUARTERS_AMBIGUOUS");
  return { actorUserId: actor.id, organizationId };
}

async function provision(pool, targetEmail, credentialPath) {
  const password = randomToken(24);
  const passwordHash = await hashPassword(password);
  let userId = crypto.randomUUID();
  const roleId = crypto.randomUUID();
  const assignmentId = crypto.randomUUID();
  let recipientId = crypto.randomUUID();
  const recipientHash = notificationRecipientHash(targetEmail);
  const recipientCiphertext = await encryptEmailTestRecipient(targetEmail);
  const recipientMask = maskEmailAddress(targetEmail);
  const roleCode = `email_delivery_acceptance_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(credentialPath), 0o700);

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agentnovas:email-delivery-account:v1',0))");
    const { actorUserId, organizationId } = await bootstrapContext(client);
    const collision = await client.query(`
      SELECT EXISTS(SELECT 1 FROM roles WHERE application_id='maintenance' AND code=$1) AS role_exists
    `, [roleCode]);
    if (collision.rows[0]?.role_exists) {
      throw new Error("EMAIL_DELIVERY_ACCEPTANCE_IDENTITY_COLLISION");
    }
    const existingIdentity = await client.query(`
      SELECT id,status,role FROM users WHERE lower(email)=lower($1) FOR UPDATE
    `, [targetEmail]);
    let reusedIdentity = false;
    if (existingIdentity.rowCount) {
      if (existingIdentity.rowCount !== 1
        || existingIdentity.rows[0].status !== "disabled"
        || existingIdentity.rows[0].role !== "employee") {
        throw new Error("EMAIL_DELIVERY_ACCEPTANCE_IDENTITY_COLLISION");
      }
      userId = existingIdentity.rows[0].id;
      const lifecycle = await client.query(`
        SELECT
          EXISTS(
            SELECT 1 FROM authorization_audit_events
             WHERE application_id='maintenance'
               AND action='maintenance.email_delivery_acceptance.provision'
               AND subject_type='user' AND subject_id=$1
          ) AS provisioned,
          EXISTS(
            SELECT 1 FROM authorization_audit_events
             WHERE application_id='maintenance'
               AND action='maintenance.email_delivery_acceptance.teardown'
               AND subject_type='user' AND subject_id=$1
          ) AS torn_down,
          EXISTS(
            SELECT 1 FROM user_role_assignments
             WHERE user_id=$1 AND application_id='maintenance' AND status='active'
          ) AS active_assignment,
          EXISTS(
            SELECT 1 FROM sessions
             WHERE user_id=$1 AND app_audience='maintenance' AND revoked_at IS NULL
               AND expires_at::timestamptz>now()
          ) AS active_session
      `, [userId]);
      const state = lifecycle.rows[0];
      if (state?.provisioned !== true || state?.torn_down !== true
        || state?.active_assignment === true || state?.active_session === true) {
        throw new Error("EMAIL_DELIVERY_ACCEPTANCE_IDENTITY_COLLISION");
      }
      reusedIdentity = true;
    }
    const existingRecipient = await client.query(`
      SELECT id,status FROM notification_email_test_recipients
      WHERE recipient_hash=$1 FOR UPDATE
    `, [recipientHash]);
    if (existingRecipient.rows[0]?.status !== undefined && existingRecipient.rows[0].status !== "deleted") {
      throw new Error("EMAIL_DELIVERY_ACCEPTANCE_RECIPIENT_COLLISION");
    }
    recipientId = existingRecipient.rows[0]?.id ?? recipientId;
    const credentialDocument = {
      accounts: {
        maintenance: {
          email: targetEmail,
          password,
          loginUrl: "https://main-test.agentnovas.com/login",
        },
      },
      metadata: { userId, roleId, assignmentId, recipientId, recipientHash, roleCode },
    };
    await writeFile(credentialPath, `${JSON.stringify(credentialDocument, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const permission = await client.query(`
      SELECT key FROM permission_definitions
      WHERE key=$1 AND application_id='maintenance' AND status='active'
    `, ["maint.email_integrations.manage"]);
    if (permission.rowCount !== 1) throw new Error("EMAIL_DELIVERY_PERMISSION_NOT_AVAILABLE");
    const timestamp = new Date().toISOString();
    if (reusedIdentity) {
      await client.query(`
        UPDATE users SET password_hash=$2,email_verified_at=$3,status='active',
          organization_id=$4,reports_to_user_id=$5,updated_at=$3
        WHERE id=$1 AND status='disabled' AND role='employee'
      `, [userId, passwordHash, timestamp, organizationId, actorUserId]);
    } else {
      await client.query(`
        INSERT INTO users(
          id,email,password_hash,email_verified_at,role,organization_id,status,
          reports_to_user_id,created_at,updated_at
        ) VALUES($1,$2,$3,$4,'employee',$5,'active',$6,$4,$4)
      `, [userId, targetEmail, passwordHash, timestamp, organizationId, actorUserId]);
    }
    await client.query(`
      INSERT INTO roles(
        id,application_id,code,name,kind,created_organization_id,
        applies_to_organization_id,status,is_system,created_by_user_id
      ) VALUES($1,'maintenance',$2,'邮件送达临时验收','custom',$3,$3,'published',false,$4)
    `, [roleId, roleCode, organizationId, actorUserId]);
    await client.query(`
      INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
      VALUES($1,$2,$3,'PLATFORM','[]'::jsonb)
    `, [crypto.randomUUID(), roleId, "maint.email_integrations.manage"]);
    await client.query(`
      INSERT INTO user_role_assignments(
        id,user_id,role_id,application_id,organization_id,status,effective_at,
        granted_by_user_id,reason,scope_organization_ids_json
      ) VALUES($1,$2,$3,'maintenance',$4,'active',$5,$6,$7,'[]'::jsonb)
    `, [assignmentId, userId, roleId, organizationId, timestamp, actorUserId, "temporary real email delivery acceptance"]);
    await client.query(`
      INSERT INTO notification_email_test_recipients(
        id,recipient_hash,recipient_ciphertext,recipient_mask,label,status,
        verification_code_hash,verification_expires_at,verification_attempts,
        verification_sent_at,verified_at,deleted_at,created_by_user_id,
        updated_by_user_id,reason,authorized_at,revoked_at,created_at,updated_at,version
      ) VALUES($1,$2,$3,$4,$5,'active',NULL,NULL,0,NULL,now(),NULL,$6,$6,$7,now(),NULL,now(),now(),1)
      ON CONFLICT(recipient_hash) DO UPDATE SET
        id=EXCLUDED.id,recipient_ciphertext=EXCLUDED.recipient_ciphertext,
        recipient_mask=EXCLUDED.recipient_mask,label=EXCLUDED.label,status='active',
        verification_code_hash=NULL,verification_expires_at=NULL,verification_attempts=0,
        verification_sent_at=NULL,verified_at=now(),deleted_at=NULL,
        updated_by_user_id=EXCLUDED.updated_by_user_id,reason=EXCLUDED.reason,
        authorized_at=now(),revoked_at=NULL,updated_at=now(),
        version=notification_email_test_recipients.version+1
      WHERE notification_email_test_recipients.status='deleted'
    `, [recipientId, recipientHash, recipientCiphertext, recipientMask,
      "真实投递临时验收邮箱", userId, "temporary real email delivery acceptance"]);
    await client.query(`
      INSERT INTO authorization_audit_events(
        id,actor_user_id,application_id,action,subject_type,subject_id,after_json,created_at
      ) VALUES($1,$2,'maintenance','maintenance.email_delivery_acceptance.provision',
        'user',$3,$4,now())
    `, [crypto.randomUUID(), actorUserId, userId, JSON.stringify({
      roleCode,
      permissionKey: "maint.email_integrations.manage",
      scope: "PLATFORM",
      recipientId,
      reusedIdentity,
      credentialDelivery: "protected_ephemeral_file",
    })]);
    await client.query("COMMIT");
    committed = true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    if (!committed) await unlink(credentialPath).catch(() => undefined);
  }
  process.stdout.write(`EMAIL_DELIVERY_ACCOUNT_CREDENTIAL_FILE=${credentialPath}\n`);
}

async function teardown(pool, targetEmail, credentialPath) {
  const canonicalCredential = await protectedRegularFile(credentialPath, [0o600]);
  const credential = JSON.parse(await readFile(canonicalCredential, "utf8"));
  const account = credential?.accounts?.maintenance;
  const metadata = credential?.metadata;
  if (normalizeEmail(account?.email ?? "") !== targetEmail || typeof account?.password !== "string") {
    throw new Error("protected credential recipient does not match the approved allowlist");
  }
  const userId = assertUuid(metadata?.userId, "userId");
  const roleId = assertUuid(metadata?.roleId, "roleId");
  const assignmentId = assertUuid(metadata?.assignmentId, "assignmentId");
  const recipientId = assertRecipientId(metadata?.recipientId);
  const recipientHash = notificationRecipientHash(targetEmail);
  if (metadata?.recipientHash !== recipientHash
    || typeof metadata?.roleCode !== "string"
    || !/^email_delivery_acceptance_\d{14}$/.test(metadata.roleCode)) {
    throw new Error("protected credential lifecycle metadata is invalid");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agentnovas:email-delivery-account:v1',0))");
    const { actorUserId } = await bootstrapContext(client);
    const identity = await client.query(`
      SELECT account.id FROM users AS account
      JOIN user_role_assignments AS assignment ON assignment.user_id=account.id
      JOIN roles AS role ON role.id=assignment.role_id
      WHERE account.id=$1 AND lower(account.email)=lower($2)
        AND assignment.id=$3 AND role.id=$4 AND role.code=$5
        AND assignment.application_id='maintenance' AND role.application_id='maintenance'
      FOR UPDATE OF account,assignment,role
    `, [userId, targetEmail, assignmentId, roleId, metadata.roleCode]);
    if (identity.rowCount !== 1) throw new Error("EMAIL_DELIVERY_ACCEPTANCE_IDENTITY_MISMATCH");
    const timestamp = new Date().toISOString();
    await client.query(`
      UPDATE sessions SET revoked_at=COALESCE(revoked_at,$2)
      WHERE user_id=$1 AND app_audience='maintenance'
    `, [userId, timestamp]);
    await client.query(`
      UPDATE user_role_assignments
      SET status='revoked',revoked_by_user_id=$2,revoked_at=$3,
          reason=$4,updated_at=$3
      WHERE id=$1 AND user_id=$5 AND role_id=$6
    `, [assignmentId, actorUserId, timestamp, "real email delivery acceptance completed", userId, roleId]);
    await client.query(`
      UPDATE roles SET status='disabled',updated_at=$2
      WHERE id=$1 AND application_id='maintenance'
    `, [roleId, timestamp]);
    await client.query(`
      UPDATE users SET status='disabled',updated_at=$2
      WHERE id=$1 AND role='employee'
    `, [userId, timestamp]);
    await client.query(`
      UPDATE notification_email_test_recipients
      SET status='deleted',recipient_ciphertext=NULL,verification_code_hash=NULL,
          verification_expires_at=NULL,verification_attempts=0,deleted_at=now(),
          updated_by_user_id=$3,reason=$4,revoked_at=now(),updated_at=now(),version=version+1
      WHERE id=$1 AND recipient_hash=$2
    `, [recipientId, recipientHash, actorUserId, "real email delivery acceptance completed"]);
    await client.query(`
      INSERT INTO authorization_audit_events(
        id,actor_user_id,application_id,action,subject_type,subject_id,
        before_json,after_json,created_at
      ) VALUES($1,$2,'maintenance','maintenance.email_delivery_acceptance.teardown',
        'user',$3,$4,$5,now())
    `, [crypto.randomUUID(), actorUserId, userId,
      JSON.stringify({ roleStatus: "published", assignmentStatus: "active", accountStatus: "active" }),
      JSON.stringify({ roleStatus: "disabled", assignmentStatus: "revoked", accountStatus: "disabled", sessionsRevoked: true }),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await unlink(canonicalCredential);
  process.stdout.write("EMAIL_DELIVERY_ACCOUNT_STATUS=revoked\n");
}

const answerPath = await protectedRegularFile(answerInput, [0o400, 0o600]);
const targetEmail = parseAllowlist(await readFile(answerPath, "utf8"));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  if (mode === "--provision") await provision(pool, targetEmail, credentialInput);
  else await teardown(pool, targetEmail, credentialInput);
} finally {
  await pool.end();
}
