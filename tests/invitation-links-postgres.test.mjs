import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

import {
  buildInvitationLink,
  findActiveReusableInvitation,
  generateInvitationCode,
  recordInvitationUse,
  revokeReusableInvitation,
} from "../lib/invitation-links.ts";
import { canCreateInvitation } from "../lib/permissions.ts";

// 可复用邀请链接：一人一条、反复使用、重新生成即旧链接失效。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `invite_link_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE invitations (
      id text PRIMARY KEY, code_hash text NOT NULL, kind text NOT NULL,
      issuer_user_id text NOT NULL, owner_employee_id text, organization_id text,
      status text NOT NULL DEFAULT 'active', used_by_user_id text, used_at text,
      created_at text NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at text NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE UNIQUE INDEX idx_invitations_code_unique ON invitations (code_hash);
  `);
  await pool.query(await readFile(new URL("../postgres/migrations/0055_reusable_invitation_links.sql", import.meta.url), "utf8"));
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

async function issue(owner, hash) {
  await pool.query(
    `INSERT INTO invitations (id, code_hash, kind, issuer_user_id, owner_employee_id, organization_id)
     VALUES ($1, $2, 'employee_reusable', $3, $3, 'org-1')`,
    [crypto.randomUUID(), hash, owner],
  );
}

test("邀请码不含易混字符", () => {
  // 链接会被口头念、被抄写。0/O/1/I 混淆会让人卡在「码明明是对的」。
  for (let attempt = 0; attempt < 50; attempt += 1) {
    assert.doesNotMatch(generateInvitationCode(8), /[01OI]/);
  }
});

test("链接指向登录页并带 invite 参数", () => {
  assert.equal(buildInvitationLink("https://a.com/", "ABC23456"), "https://a.com/login?invite=ABC23456");
});

test("一个人只能有一条生效中的链接", async () => {
  await issue("emp-1", "hash-1");
  await assert.rejects(() => issue("emp-1", "hash-2"), /uq_invitations_active_reusable_owner/);
});

test("不同的人各有自己的链接", async () => {
  await issue("emp-2", "hash-3");
  assert.ok(await findActiveReusableInvitation(pool, "emp-1"));
  assert.ok(await findActiveReusableInvitation(pool, "emp-2"));
});

test("可复用链接反复使用不会失效", async () => {
  // 这是与一次性码最根本的区别：用完仍是 active。
  const before = await findActiveReusableInvitation(pool, "emp-1");
  for (let index = 0; index < 3; index += 1) {
    await recordInvitationUse(pool, { invitationId: before.id, now: "2026-08-23T00:00:00.000Z" });
  }
  const after = await findActiveReusableInvitation(pool, "emp-1");
  assert.equal(after.status, "active");
  assert.equal(after.useCount, 3, "使用次数是判断链接是否外泄的唯一信号");
  assert.equal(after.lastUsedAt, "2026-08-23T00:00:00.000Z");
});

test("重新生成必须先撤销旧的，否则撞唯一约束", async () => {
  const revoked = await revokeReusableInvitation(pool, {
    ownerEmployeeId: "emp-1", revokedBy: "emp-1", now: "2026-08-23T01:00:00.000Z",
  });
  assert.ok(revoked.revokedId);
  assert.equal(await findActiveReusableInvitation(pool, "emp-1"), null);
  await issue("emp-1", "hash-4");
  assert.ok(await findActiveReusableInvitation(pool, "emp-1"), "撤销之后可以重新生成");
});

test("撤销必须记录是谁撤的", async () => {
  await assert.rejects(
    () => pool.query("UPDATE invitations SET status='revoked' WHERE code_hash='hash-3'"),
    /invitations_revoked_is_recorded/,
  );
});

test("撤销与用尽是两种不同的失效，不得混用", async () => {
  // used 是一次性码被消费，revoked 是链接被主动作废。
  // 混用会让审计说不清链接是怎么失效的。
  const row = (await pool.query("SELECT status, revoked_by_user_id FROM invitations WHERE code_hash='hash-1'")).rows[0];
  assert.equal(row.status, "revoked");
  assert.equal(row.revoked_by_user_id, "emp-1");
});

test("可复用链接必须有归属人——它就是「谁邀请的」的答案", async () => {
  await assert.rejects(
    () => pool.query(
      `INSERT INTO invitations (id, code_hash, kind, issuer_user_id, owner_employee_id)
       VALUES ('x','hx','employee_reusable','emp-9',NULL)`),
    /invitations_owner_matches_kind/,
  );
});

test("上级也能生成自己的链接，客户不能", () => {
  // 归因链从 owner 沿 reports_to_user_id 往上走，任何一级作为起点都成立。
  for (const role of ["employee", "supervisor", "manager", "branch_admin", "hq_support", "hq_admin"]) {
    assert.equal(canCreateInvitation(role, "employee_reusable"), true, `${role} 应该能生成`);
  }
  // 客户邀请客户会让归因链从一个不在汇报体系里的节点起步。
  assert.equal(canCreateInvitation("customer", "employee_reusable"), false);
});
