import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

// 审计防篡改（迁移 0044）。
//
// 0022 已经把资金表锁死，但审计侧此前没有任何保护——audit_logs 和各 *_decisions
// 表可以被有写权限的人改或删。对靠 maker/checker 双人复核立身的系统，这意味着
// 「谁批准了什么」的记录可以被伪造。本测试证明两条保护同时成立：
//   1. append-only 触发器挡住常规 UPDATE/DELETE；
//   2. 即使有人有权限禁用触发器，哈希链仍能检出内容改动与行删除。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `audit_tamper_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
// search_path 只含临时 schema：迁移里的 to_regclass 必须在本 schema 内解析，
// 否则会给共享数据库 public 下的同名真实表挂触发器。
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

const DECISION_TABLES = [
  "approval_decisions",
  "access_change_decisions",
  "ai_credit_adjustment_decisions",
  "commercial_membership_order_decisions",
  "customer_attribution_change_decisions",
  "deposit_action_decisions",
  "performance_fee_decisions",
  "platform_decisions",
];

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE audit_logs (
      id text PRIMARY KEY,
      actor_user_id text,
      action text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      before_json text,
      after_json text,
      ip_address text,
      user_agent text,
      created_at text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  `);
  for (const table of DECISION_TABLES) {
    await pool.query(`CREATE TABLE "${table}" (id text PRIMARY KEY, decided_by text, decision text)`);
  }
  // 存量行：迁移必须能回填它们，且回填顺序确定。
  await pool.query(`
    INSERT INTO audit_logs (id, action, subject_type, subject_id, created_at) VALUES
      ('legacy-1','role.grant','user','u1','2026-01-01T00:00:00.000Z'),
      ('legacy-2','role.revoke','user','u1','2026-01-02T00:00:00.000Z');
  `);
  const migration = await readFile(new URL("../postgres/migrations/0044_audit_tamper_evidence.sql", import.meta.url), "utf8");
  await pool.query(migration);
});

test.after(async () => {
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await Promise.all([pool.end(), adminPool.end()]);
});

test("迁移回填存量行并建立连续哈希链", async () => {
  const { rows } = await pool.query(
    "SELECT id, chain_seq, prev_hash, row_hash FROM audit_logs ORDER BY chain_seq",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.id), ["legacy-1", "legacy-2"]);
  assert.equal(Number(rows[0].chain_seq), 1);
  // 首行的 prev_hash 是 32 字节全零创世值。
  assert.equal(rows[0].prev_hash.toString("hex"), "0".repeat(64));
  // 后一行的 prev_hash 必须等于前一行的 row_hash。
  assert.equal(rows[1].prev_hash.toString("hex"), rows[0].row_hash.toString("hex"));

  const problems = await pool.query("SELECT * FROM verify_audit_log_chain()");
  assert.deepEqual(problems.rows, []);
});

test("新插入自动接链，校验函数保持干净", async () => {
  await pool.query(`
    INSERT INTO audit_logs (id, action, subject_type, subject_id, after_json)
    VALUES ('new-1','deposit.approve','deposit','d1','{"amount":"100.00"}');
  `);
  const { rows } = await pool.query(
    "SELECT chain_seq, prev_hash, row_hash FROM audit_logs ORDER BY chain_seq",
  );
  assert.equal(rows.length, 3);
  assert.equal(Number(rows[2].chain_seq), 3);
  assert.equal(rows[2].prev_hash.toString("hex"), rows[1].row_hash.toString("hex"));

  const problems = await pool.query("SELECT * FROM verify_audit_log_chain()");
  assert.deepEqual(problems.rows, []);
});

test("audit_logs 拒绝 UPDATE 与 DELETE", async () => {
  await assert.rejects(
    () => pool.query("UPDATE audit_logs SET action = 'tampered' WHERE id = 'new-1'"),
    /AUDIT_APPEND_ONLY/,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM audit_logs WHERE id = 'new-1'"),
    /AUDIT_APPEND_ONLY/,
  );
  const { rows } = await pool.query("SELECT action FROM audit_logs WHERE id = 'new-1'");
  assert.equal(rows[0].action, "deposit.approve");
});

test("全部 decisions 表拒绝 UPDATE 与 DELETE", async () => {
  for (const table of DECISION_TABLES) {
    await pool.query(`INSERT INTO "${table}" (id, decided_by, decision) VALUES ('d-1','checker-1','approved')`);
    await assert.rejects(
      () => pool.query(`UPDATE "${table}" SET decided_by = 'forged' WHERE id = 'd-1'`),
      /AUDIT_APPEND_ONLY/,
      `${table} 应拒绝 UPDATE`,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM "${table}" WHERE id = 'd-1'`),
      /AUDIT_APPEND_ONLY/,
      `${table} 应拒绝 DELETE`,
    );
  }
});

test("绕过触发器改内容时，哈希链检出被改动的行", async () => {
  // 模拟持有足够权限的人禁用保护后改写历史。
  await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  await pool.query(`UPDATE audit_logs SET after_json = '{"amount":"10000.00"}' WHERE id = 'new-1'`);
  await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");

  const { rows } = await pool.query("SELECT chain_seq, id, reason FROM verify_audit_log_chain()");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "new-1");
  assert.match(rows[0].reason, /row_hash/);

  // 还原原值，让后续测试从一条干净的链开始。哈希只取决于内容，
  // 改回原值链就自洽了——这本身也说明检出依据是内容而非时间戳。
  await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  await pool.query(`UPDATE audit_logs SET after_json = '{"amount":"100.00"}' WHERE id = 'new-1'`);
  await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  const restored = await pool.query("SELECT * FROM verify_audit_log_chain()");
  assert.deepEqual(restored.rows, []);
});

test("绕过触发器删除中间行时，哈希链检出缺口", async () => {
  await pool.query(`
    INSERT INTO audit_logs (id, action, subject_type, subject_id)
    VALUES ('new-2','member.activate','order','o1');
  `);
  const before = await pool.query("SELECT count(*)::int AS total FROM audit_logs");
  assert.equal(before.rows[0].total, 4);

  // 掩盖一次审批：删掉链条中间的一行。
  await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  await pool.query("DELETE FROM audit_logs WHERE id = 'new-1'");
  await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");

  const { rows } = await pool.query("SELECT chain_seq, id, reason FROM verify_audit_log_chain()");
  const reasons = rows.map((row) => row.reason).join(" | ");
  assert.ok(rows.length >= 1, "删除中间行必须被检出");
  assert.ok(rows.every((row) => row.id === "new-2"), "断裂应定位到缺口之后的第一行");
  assert.match(reasons, /序号断裂|prev_hash/);
});

test("已知局限：删除链尾不破坏剩余行的自洽性，需要外部锚点", async () => {
  // 这条不是缺陷而是哈希链的固有性质，明确记录下来避免误判防护强度。
  // 要检出「截断链尾」，必须把链尾哈希定期外送到本库之外（备份、日志系统或
  // 运维端存档）。这属于 GA 前的运维动作，不是数据库能自己解决的问题。
  const tail = await pool.query("SELECT id FROM audit_logs ORDER BY chain_seq DESC LIMIT 1");
  const tailId = tail.rows[0].id;

  await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  await pool.query("DELETE FROM audit_logs WHERE id = $1", [tailId]);
  await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");

  const { rows } = await pool.query("SELECT * FROM verify_audit_log_chain()");
  assert.deepEqual(rows, [], "链内校验无法自证链尾被截断——这是预期的局限");
});
