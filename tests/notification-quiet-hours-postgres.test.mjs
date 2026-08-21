import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { claimNextEmailDelivery } from "../lib/notification-email-worker.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `notification_quiet_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of [
    "0000_business_schema.sql",
    "0015_riverton_three_app_rbac_wallet.sql",
    "0017_notification_outbox_leases.sql",
    "0021_identity_access_hardening.sql",
  ]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

async function arrangeDelivery(input) {
  await pool.query("TRUNCATE notification_preferences,notification_deliveries,users CASCADE");
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status,timezone)
    VALUES('quiet-user','quiet@example.test','hash','customer','active',$1)
  `, [input.timezone]);
  if (input.quietStart) {
    await pool.query(`
      INSERT INTO notification_preferences(id,user_id,channel,category,mode,quiet_start,quiet_end)
      VALUES('quiet-pref','quiet-user','email','market_news','instant',$1,$2)
    `, [input.quietStart, input.quietEnd]);
  }
  await pool.query(`
    INSERT INTO notification_deliveries(
      id,user_id,channel,category,template_key,payload_json,status,attempts,scheduled_at
    ) VALUES(
      'quiet-delivery','quiet-user','email','market_news','membership_read_only',
      '{"planCode":"monthly","effectiveAt":"2026-01-01T00:00:00.000Z"}',
      'queued',0,$1
    )
  `, [input.scheduledAt]);
}

async function deliveryState() {
  return (await pool.query(`
    SELECT scheduled_at,attempts,lease_owner,lease_expires_at
      FROM notification_deliveries
     WHERE id='quiet-delivery'
  `)).rows[0];
}

test("inside same-day quiet hours reschedules to the local end without claiming", async () => {
  await arrangeDelivery({
    timezone: "Asia/Shanghai",
    quietStart: "09:00",
    quietEnd: "17:00",
    scheduledAt: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(await claimNextEmailDelivery(pool, {
    workerId: "quiet-worker",
    now: new Date("2026-08-21T06:30:00.000Z"),
  }), null);
  assert.deepEqual(await deliveryState(), {
    scheduled_at: "2026-08-21T09:00:00.000Z",
    attempts: 0,
    lease_owner: null,
    lease_expires_at: null,
  });
  assert.equal(await claimNextEmailDelivery(pool, {
    workerId: "quiet-worker",
    now: new Date("2026-08-21T06:30:00.000Z"),
  }), null);
  assert.equal((await deliveryState()).scheduled_at, "2026-08-21T09:00:00.000Z");
});

test("email quiet hours do not reschedule in-app delivery records", async () => {
  await arrangeDelivery({
    timezone: "Asia/Shanghai",
    quietStart: "09:00",
    quietEnd: "17:00",
    scheduledAt: "2026-08-21T00:00:00.000Z",
  });
  await pool.query(`
    INSERT INTO notification_deliveries(
      id,user_id,channel,category,template_key,payload_json,status,attempts,scheduled_at
    ) VALUES(
      'quiet-in-app','quiet-user','in_app','market_news','membership_read_only',
      '{"planCode":"monthly","effectiveAt":"2026-01-01T00:00:00.000Z"}',
      'queued',0,'2026-08-21T00:00:00.000Z'
    )
  `);
  assert.equal(await claimNextEmailDelivery(pool, {
    workerId: "quiet-worker",
    now: new Date("2026-08-21T06:30:00.000Z"),
  }), null);
  assert.deepEqual((await pool.query(`
    SELECT scheduled_at,attempts,lease_owner,lease_expires_at
      FROM notification_deliveries
     WHERE id='quiet-in-app'
  `)).rows[0], {
    scheduled_at: "2026-08-21T00:00:00.000Z",
    attempts: 0,
    lease_owner: null,
    lease_expires_at: null,
  });
});

test("outside quiet hours claims the due email normally", async () => {
  await arrangeDelivery({
    timezone: "Asia/Shanghai",
    quietStart: "22:00",
    quietEnd: "07:00",
    scheduledAt: "2026-08-21T00:00:00.000Z",
  });
  const claimed = await claimNextEmailDelivery(pool, {
    workerId: "quiet-worker",
    now: new Date("2026-08-21T12:00:00.000Z"),
  });
  assert.equal(claimed.id, "quiet-delivery");
  assert.equal(claimed.attempts, 1);
  assert.equal((await deliveryState()).lease_owner, "quiet-worker");
});

test("overnight quiet hours reschedule both sides of local midnight", async () => {
  for (const [now, expected] of [
    ["2026-08-21T15:30:00.000Z", "2026-08-21T23:00:00.000Z"],
    ["2026-08-21T22:30:00.000Z", "2026-08-21T23:00:00.000Z"],
  ]) {
    await arrangeDelivery({
      timezone: "Asia/Shanghai",
      quietStart: "22:00",
      quietEnd: "07:00",
      scheduledAt: "2026-08-21T00:00:00.000Z",
    });
    assert.equal(await claimNextEmailDelivery(pool, { workerId: "quiet-worker", now: new Date(now) }), null);
    assert.equal((await deliveryState()).scheduled_at, expected);
  }
});

test("DST transition resolves the quiet end in the user's IANA timezone", async () => {
  await arrangeDelivery({
    timezone: "America/New_York",
    quietStart: "01:30",
    quietEnd: "03:30",
    scheduledAt: "2026-03-08T00:00:00.000Z",
  });
  assert.equal(await claimNextEmailDelivery(pool, {
    workerId: "quiet-worker",
    now: new Date("2026-03-08T06:45:00.000Z"),
  }), null);
  assert.equal((await deliveryState()).scheduled_at, "2026-03-08T07:30:00.000Z");
});
