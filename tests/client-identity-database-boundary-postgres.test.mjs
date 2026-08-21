import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const suffix = `${process.pid}_${Date.now()}`;
const schema = `client_identity_rls_${suffix}`;
const internalRole = `agentnovas_test_internal_${suffix}`;
const clientRole = "agentnovas_client_web";
const clientAuthRole = "agentnovas_client_auth";
const clientToken1 = "1".repeat(64);
const clientToken2 = "2".repeat(64);
const expiredClientToken = "3".repeat(64);
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let createdClientRole = false;
let createdInternalRole = false;
let createdClientAuthRole = false;

const quotedIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

async function withRole(role, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${quotedIdentifier(role)}`);
    await callback(client);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  assert.match(internalRole, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`);
  await pool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,email text NOT NULL,phone text,username text,nickname text NOT NULL DEFAULT '',
      avatar_url text NOT NULL DEFAULT '',date_of_birth text,gender text NOT NULL DEFAULT '',password_hash text NOT NULL,
      email_verified_at text,role text NOT NULL,organization_id text,reports_to_user_id text,status text NOT NULL DEFAULT 'active',
      locale text NOT NULL DEFAULT 'zh-CN',timezone text NOT NULL DEFAULT 'Asia/Shanghai',created_at text NOT NULL DEFAULT now()::text,
      updated_at text NOT NULL DEFAULT now()::text
    );
    CREATE TABLE sessions (
      id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),token_hash text NOT NULL,app_audience text NOT NULL,
      expires_at text NOT NULL,revoked_at text,ip_address text,user_agent text,created_at text NOT NULL DEFAULT now()::text,
      mfa_level text NOT NULL DEFAULT 'none',mfa_verified_at timestamptz,last_seen_at timestamptz,idle_expires_at timestamptz,
      absolute_expires_at timestamptz,session_version bigint NOT NULL DEFAULT 1
    );
    CREATE TABLE auth_tokens (
      id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),token_hash text NOT NULL,purpose text NOT NULL,
      token_audience text NOT NULL,expires_at text NOT NULL,used_at text,created_at text NOT NULL DEFAULT now()::text
    );
    CREATE TABLE user_mfa_totp_credentials (
      user_id text PRIMARY KEY REFERENCES users(id),encrypted_secret text NOT NULL,encryption_key_version integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'pending',last_accepted_counter bigint,enabled_at timestamptz,disabled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE user_mfa_recovery_codes (
      id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),code_hash text NOT NULL,used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE invitations (
      id text PRIMARY KEY,code_hash text NOT NULL,kind text NOT NULL,issuer_user_id text NOT NULL,
      owner_employee_id text,organization_id text,status text NOT NULL DEFAULT 'active',used_by_user_id text,
      used_at text,created_at text NOT NULL DEFAULT now()::text,updated_at text NOT NULL DEFAULT now()::text
    );
    CREATE TABLE notification_deliveries (
      id text PRIMARY KEY,user_id text NOT NULL,channel text NOT NULL,category text NOT NULL,
      template_key text NOT NULL,payload_json text NOT NULL,scheduled_at timestamptz NOT NULL,
      secret_kind text,secret_expires_at timestamptz
    );
    INSERT INTO users(id,email,password_hash,role,reports_to_user_id) VALUES
      ('customer-1','customer1@example.test','hash-c1','customer',NULL),
      ('customer-2','customer2@example.test','hash-c2','customer',NULL),
      ('employee-1','employee@example.test','hash-e1','employee','supervisor-1'),
      ('supervisor-1','supervisor@example.test','hash-s1','supervisor','manager-1'),
      ('manager-1','manager@example.test','hash-m1','manager',NULL),
      ('maint-1','maint@example.test','hash-maint','hq_admin',NULL);
    INSERT INTO sessions(id,user_id,token_hash,app_audience,expires_at,idle_expires_at,absolute_expires_at) VALUES
      ('client-session-1','customer-1','${clientToken1}','client','2099-01-01','2099-01-01','2099-01-01'),
      ('client-session-2','customer-2','${clientToken2}','client','2099-01-01','2099-01-01','2099-01-01'),
      ('client-session-expired','customer-1','${expiredClientToken}','client','2020-01-01','2020-01-01','2020-01-01'),
      ('ops-session-customer','customer-1','ops-token-customer','operations','2099-01-01','2099-01-01','2099-01-01'),
      ('client-session-internal','maint-1','client-token-internal','client','2099-01-01','2099-01-01','2099-01-01'),
      ('maint-session-1','maint-1','maint-token-1','maintenance','2099-01-01','2099-01-01','2099-01-01');
    INSERT INTO auth_tokens(id,user_id,token_hash,purpose,token_audience,expires_at) VALUES
      ('client-reset-1','customer-1','reset-client-1','reset_password','client','2099-01-01'),
      ('ops-reset-customer','customer-1','reset-ops-customer','reset_password','operations','2099-01-01'),
      ('client-reset-internal','maint-1','reset-client-internal','reset_password','client','2099-01-01'),
      ('maint-reset-1','maint-1','reset-maint-1','reset_password','maintenance','2099-01-01');
    INSERT INTO user_mfa_totp_credentials(user_id,encrypted_secret,status) VALUES
      ('customer-1','encrypted-customer','active'),('maint-1','encrypted-maint','active');
    INSERT INTO user_mfa_recovery_codes(id,user_id,code_hash) VALUES
      ('recovery-customer','customer-1','recovery-hash-customer'),('recovery-maint','maint-1','recovery-hash-maint');
    INSERT INTO invitations(id,code_hash,kind,issuer_user_id,owner_employee_id,status)
      VALUES('invite-1','invite-hash-1','employee_reusable','manager-1','employee-1','active');
  `);

  const migration = await readFile(new URL("../postgres/migrations/0040_client_identity_rls.sql", import.meta.url), "utf8");
  const preparedMigration = migration
      .replaceAll("pg_catalog, public", `pg_catalog, ${quotedIdentifier(schema)}`)
      .replaceAll("public.", `${quotedIdentifier(schema)}.`)
      .replaceAll("'agentnovas_ops_web'", `'${internalRole}'`);
  await pool.query(preparedMigration);
  await pool.query(preparedMigration);

  const role = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [clientRole]);
  if (!role.rowCount) {
    await adminPool.query(`CREATE ROLE ${quotedIdentifier(clientRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    createdClientRole = true;
  }
  const authRole = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [clientAuthRole]);
  if (!authRole.rowCount) {
    await adminPool.query(`CREATE ROLE ${quotedIdentifier(clientAuthRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    createdClientAuthRole = true;
  }
  await adminPool.query(`CREATE ROLE ${quotedIdentifier(internalRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  createdInternalRole = true;
  await pool.query(`
    GRANT USAGE ON SCHEMA ${quotedIdentifier(schema)} TO ${quotedIdentifier(clientRole)},${quotedIdentifier(clientAuthRole)},${quotedIdentifier(internalRole)};
    GRANT SELECT,INSERT,UPDATE,DELETE ON users,sessions,auth_tokens,user_mfa_totp_credentials,user_mfa_recovery_codes,invitations TO ${quotedIdentifier(internalRole)};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quotedIdentifier(schema)} TO ${quotedIdentifier(clientRole)};
    REVOKE EXECUTE ON FUNCTION client_login_identity(text,text,text) FROM ${quotedIdentifier(clientRole)};
    REVOKE EXECUTE ON FUNCTION client_self_password_identity(text,timestamptz) FROM ${quotedIdentifier(clientRole)};
    REVOKE EXECUTE ON FUNCTION client_queue_password_reset(text,text,text,timestamptz,text,text,timestamptz) FROM ${quotedIdentifier(clientRole)};
    GRANT EXECUTE ON FUNCTION client_login_identity(text,text,text),client_self_password_identity(text,timestamptz),client_queue_password_reset(text,text,text,timestamptz,text,text,timestamptz) TO ${quotedIdentifier(clientAuthRole)};
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA ${quotedIdentifier(schema)} CASCADE`);
  if (createdInternalRole) await adminPool.query(`DROP ROLE ${quotedIdentifier(internalRole)}`);
  if (createdClientAuthRole) await adminPool.query(`DROP ROLE ${quotedIdentifier(clientAuthRole)}`);
  if (createdClientRole) await adminPool.query(`DROP ROLE ${quotedIdentifier(clientRole)}`);
  await adminPool.end();
});

async function rejectsAsClient(sql, values = []) {
  await withRole(clientRole, async (client) => {
    await assert.rejects(client.query(sql, values), (error) => error.code === "42501");
  });
}

test("Client role has no direct identity or invitation table access", async () => {
  for (const table of ["users", "sessions", "auth_tokens", "user_mfa_totp_credentials", "user_mfa_recovery_codes", "invitations"]) {
    await rejectsAsClient(`SELECT * FROM ${table} LIMIT 1`);
  }
  await rejectsAsClient("UPDATE users SET password_hash='attacker' WHERE id='customer-2'");
  await rejectsAsClient("DELETE FROM user_mfa_recovery_codes WHERE user_id='customer-2'");
});

test("exact login/session capabilities cannot resolve internal or another customer session", async () => {
  await withRole(clientAuthRole, async (client) => {
    const login = await client.query("SELECT user_json FROM client_login_identity('__none__','customer1@example.test','customer1@example.test')");
    assert.equal(login.rows[0].user_json.id, "customer-1");
    assert.equal((await client.query("SELECT user_json FROM client_login_identity('__none__','maint@example.test','maint@example.test')")).rowCount, 0);
    assert.equal((await client.query("SELECT client_self_password_identity($1,now()) AS password_hash", [clientToken1])).rows[0].password_hash, "hash-c1");
    await assert.rejects(
      client.query("SELECT client_complete_login($1,$2,NULL,$3,$4,now()+interval '1 day','none',now(),now()+interval '1 hour',now()+interval '1 day',NULL,NULL)", ["customer-1","hash-c1","forged-session","f".repeat(64)]),
      (error) => error.code === "42501",
    );
  });
  await withRole(clientAuthRole, async (client) => {
    await assert.rejects(
      client.query("SELECT * FROM client_consume_password_reset($1,$2,now())", ["reset-client-1","attacker"]),
      (error) => error.code === "42501",
    );
  });
  await withRole(clientRole, async (client) => {
    await assert.rejects(
      client.query("SELECT user_json FROM client_login_identity('__none__','customer1@example.test','customer1@example.test')"),
      (error) => error.code === "42501",
    );
  });
  await withRole(clientRole, async (client) => {
    await assert.rejects(
      client.query("SELECT client_self_password_identity($1,now())", [clientToken1]),
      (error) => error.code === "42501",
    );
  });
  await withRole(clientRole, async (client) => {
    await assert.rejects(
      client.query("SELECT client_queue_password_reset($1,$2,$3,now()+interval '1 hour',$4,$5,now())", ["customer1@example.test","evil-token","e".repeat(64),"evil-delivery","{}"]),
      (error) => error.code === "42501",
    );
  });
  await withRole(clientRole, async (client) => {
    const self = await client.query("SELECT user_json,session_json FROM client_session_identity($1,now())", [clientToken1]);
    assert.equal(self.rows[0].user_json.id, "customer-1");
    assert.equal(self.rows[0].user_json.password_hash, "");
    assert.equal((await client.query("SELECT * FROM client_session_identity('client-token-2-wrong',now())")).rowCount, 0);
    assert.equal((await client.query("SELECT client_revoke_session($1,'client-session-2',now()) AS audience", [clientToken1])).rows[0].audience, null);
  });
});

test("Client registration/login/profile/MFA/session flows use bounded gateways", async () => {
  await withRole(clientRole, async (client) => {
    assert.equal((await client.query("SELECT client_touch_session($1,now(),now()+interval '1 hour') AS changed", [clientToken1])).rows[0].changed, true);
    assert.equal((await client.query("SELECT client_mfa_accept_totp($1,42,now()) AS changed", [clientToken1])).rows[0].changed, true);
    assert.equal((await client.query("SELECT client_mfa_consume_recovery($1,'recovery-hash-customer',now()) AS changed", [clientToken1])).rows[0].changed, true);
    const invitation = await client.query("SELECT * FROM client_registration_invitation('invite-hash-1')");
    assert.equal(invitation.rows[0].id, "invite-1");
    const inserted = await client.query("SELECT * FROM client_insert_invited_customer($1,$2,$3,$4,$5,$6)", [
      "customer-new", "new@example.test", "+15550001111", "hash-new", "invite-1", "invite-hash-1",
    ]);
    assert.equal(inserted.rows[0].kind, "employee_reusable");
    const attribution = await client.query("SELECT * FROM client_registration_attribution($1,$2)", ["invite-1", "invite-hash-1"]);
    assert.deepEqual(attribution.rows, [{ manager_id: "manager-1", supervisor_id: "supervisor-1" }]);
    assert.equal(JSON.stringify(attribution.rows).includes("employee@example.test"), false);
  });
});

test("expired but unrevoked Client capabilities cannot authorize any self mutation", async () => {
  await withRole(clientRole, async (client) => {
    assert.equal((await client.query("SELECT * FROM client_session_identity($1,now())", [expiredClientToken])).rowCount, 0);
    assert.equal((await client.query("SELECT client_touch_session($1,now(),now()+interval '1 hour') AS changed", [expiredClientToken])).rows[0].changed, false);
    assert.equal((await client.query("SELECT client_change_password($1,$2,$3,now()) AS changed", [expiredClientToken,"hash-c1","attacker"])).rows[0].changed, false);
    assert.equal((await client.query("SELECT client_mfa_accept_totp($1,99,now()) AS changed", [expiredClientToken])).rows[0].changed, false);
    assert.equal((await client.query("SELECT * FROM client_list_sessions($1,now())", [expiredClientToken])).rowCount, 0);
  });
});

test("an independent internal role retains its identity workflows", async () => {
  await withRole(internalRole, async (client) => {
    const users = await client.query("SELECT id FROM users ORDER BY id");
    assert.equal(users.rows.some((row) => row.id === "maint-1"), true);
    const sessions = await client.query("SELECT id FROM sessions ORDER BY id");
    assert.equal(sessions.rows.some((row) => row.id === "maint-session-1"), true);
    const tokens = await client.query("SELECT id FROM auth_tokens ORDER BY id");
    assert.equal(tokens.rows.some((row) => row.id === "maint-reset-1"), true);
    const mfa = await client.query("SELECT encrypted_secret FROM user_mfa_totp_credentials WHERE user_id='maint-1'");
    assert.equal(mfa.rows[0].encrypted_secret, "encrypted-maint");
  });
});
