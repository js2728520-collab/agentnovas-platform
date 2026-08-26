import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

import {
  listAuditChainAnchors,
  recordAuditChainAnchor,
  verifyAuditChainAnchors,
} from "../lib/audit-chain-anchor.ts";

// 审计链尾锚定。
//
// 0044 的哈希链能检出「改内容」与「删中间行」，但**检不出截断链尾**——
// 把最后 N 行删掉，剩下的链依然自洽。这个测试的核心就是把这件事演出来：
// 截断之后链内校验报告「完好」，而锚点抓到了。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `audit_anchor_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // audit_logs 的最小形态，字段取自实际表结构。
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
      created_at text NOT NULL DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      request_id text,
      trace_id text,
      error_code text
    );
  `);
  for (const file of ["0044_audit_tamper_evidence.sql", "0049_audit_chain_anchors.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${file}`, import.meta.url), "utf8"));
  }
});

after(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

const writeEntries = (count, offset = 0) => pool.query(`
  INSERT INTO audit_logs (id, action, subject_type, subject_id)
  SELECT 'entry-' || (g + $2), 'act', 'sub', 's' || (g + $2) FROM generate_series(1, $1) AS g
`, [count, offset]);

test("空审计表不产生零值锚点", async () => {
  // 假锚点会让「没有保护」看起来像「有保护」（INV-6）。
  assert.equal(await recordAuditChainAnchor(pool, { anchoredBy: "ops" }), null);
  assert.deepEqual(await verifyAuditChainAnchors(pool), []);
});

test("登记锚点后校验通过", async () => {
  await writeEntries(5);
  const anchor = await recordAuditChainAnchor(pool, { anchoredBy: "ops-archive" });
  assert.equal(anchor.created, true);
  assert.equal(anchor.chainSeq, "5");
  assert.equal(anchor.entryCount, "5");
  assert.match(anchor.rowHashHex, /^[0-9a-f]{64}$/);
  assert.deepEqual(await verifyAuditChainAnchors(pool), []);
});

test("链尾没变时不重复登记", async () => {
  // 反复登记同一个链尾只会让归档变吵，不增加任何保护。
  const again = await recordAuditChainAnchor(pool, { anchoredBy: "ops-archive" });
  assert.equal(again.created, false);
  assert.equal((await listAuditChainAnchors(pool, { limit: 50 })).length, 1);
});

test("链尾推进后可以登记新锚点", async () => {
  await writeEntries(3, 5);
  const anchor = await recordAuditChainAnchor(pool, { anchoredBy: "ops-archive" });
  assert.equal(anchor.created, true);
  assert.equal(anchor.chainSeq, "8");
  assert.deepEqual(await verifyAuditChainAnchors(pool), []);
});

test("锚点自身是 append-only", async () => {
  // 可改的锚点等于没有锚点。
  await assert.rejects(
    () => pool.query("UPDATE audit_chain_anchors SET entry_count = 0"),
    /AUDIT_APPEND_ONLY/,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM audit_chain_anchors"),
    /AUDIT_APPEND_ONLY/,
  );
});

test("截断链尾：链内校验查不出来，锚点能查出来", async () => {
  // 这是整个机制存在的理由。攻击者要截断就得先卸掉 append-only 触发器——
  // 这里照着做，验证卸掉之后锚点仍然有效。
  await pool.query("DROP TRIGGER audit_logs_append_only ON audit_logs");
  await pool.query("DELETE FROM audit_logs WHERE chain_seq > 6");

  const chainProblems = await pool.query("SELECT * FROM verify_audit_log_chain()");
  assert.equal(chainProblems.rows.length, 0,
    "截断后剩下的链依然自洽——这正是链内校验的盲区");

  const violations = await verifyAuditChainAnchors(pool);
  assert.ok(violations.length > 0, "锚点必须发现链尾被截断");
  assert.ok(violations.some((item) => /已不存在/.test(item.reason)),
    `实际违例：${JSON.stringify(violations)}`);
  assert.ok(violations.some((item) => item.chainSeq === "8"),
    "被截掉的那个锚定序号应当被点名");
});

test("改写被锚定行的内容也会被抓到", async () => {
  // 与截断不同的失败模式：行还在，但内容变了。
  await pool.query("UPDATE audit_logs SET row_hash = sha256('forged') WHERE chain_seq = 5");
  const violations = await verifyAuditChainAnchors(pool);
  assert.ok(violations.some((item) => item.chainSeq === "5" && /哈希与登记值不一致/.test(item.reason)),
    `实际违例：${JSON.stringify(violations)}`);
});
