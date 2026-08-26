import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

import { recordAuditChainAnchor, verifyAuditChainAnchors } from "../lib/audit-chain-anchor.ts";
import {
  buildAuditAnchorExport,
  verifyAuditAnchorExport,
} from "../lib/audit-anchor-export.ts";

// 这个文件的核心是一个演示：把审计行**连同锚点一起**删掉之后，
// 库内校验报告「干净」，而库外导出件抓到了。
//
// 库内的 verify_audit_chain_anchors() 只遍历库里还存在的锚点——
// 被删掉的锚点不会替自己发声。这是它结构上做不到的事，不是实现缺陷。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `audit_export_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

const KEY = "test-anchor-export-key-0123456789abcdef";

async function appendLogs(count) {
  for (let index = 0; index < count; index += 1) {
    await pool.query(
      `INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id)
       VALUES ($1, NULL, 'test.event', 'test', $2)`,
      [crypto.randomUUID(), `subject-${index}`],
    );
  }
}

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE audit_logs (
      id text PRIMARY KEY, actor_user_id text, action text NOT NULL,
      subject_type text NOT NULL, subject_id text NOT NULL,
      before_json text, after_json text, ip_address text, user_agent text,
      created_at text NOT NULL DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      request_id text, trace_id text, error_code text
    );
  `);
  for (const file of ["0044_audit_tamper_evidence.sql", "0049_audit_chain_anchors.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${file}`, import.meta.url), "utf8"));
  }
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

test("空锚点表导出为空清单，不造假锚点", async () => {
  const document = await buildAuditAnchorExport(pool, { exportedBy: "ops-1", signingKey: KEY });
  assert.equal(document.anchorCount, 0);
  assert.deepEqual(document.anchors, []);
});

test("导出件包含全部锚点并带签名", async () => {
  await appendLogs(5);
  await recordAuditChainAnchor(pool, { anchoredBy: "ops-1" });
  await appendLogs(5);
  await recordAuditChainAnchor(pool, { anchoredBy: "ops-1" });

  const document = await buildAuditAnchorExport(pool, { exportedBy: "ops-1", signingKey: KEY });
  assert.equal(document.anchorCount, 2);
  assert.equal(document.signed, true);
  assert.match(document.signature, /^[0-9a-f]{64}$/);
});

test("未配置签名密钥时明确标注未签名，而不是假装安全", async () => {
  const document = await buildAuditAnchorExport(pool, { exportedBy: "ops-1", signingKey: undefined });
  assert.equal(document.signed, false);
  assert.equal(document.signature, null);
});

test("完好的库回验通过", async () => {
  const document = await buildAuditAnchorExport(pool, { exportedBy: "ops-1", signingKey: KEY });
  assert.deepEqual(await verifyAuditAnchorExport(pool, document, { signingKey: KEY }), []);
});

test("改动导出件里的锚点会被摘要抓到", async () => {
  const document = await buildAuditAnchorExport(pool, { exportedBy: "ops-1", signingKey: KEY });
  document.anchors[0].rowHashHex = "0".repeat(64);
  const violations = await verifyAuditAnchorExport(pool, document, { signingKey: KEY });
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /导出件被改动/);
});

test("用错误的密钥验签会被拒绝", async () => {
  const document = await buildAuditAnchorExport(pool, { exportedBy: "ops-1", signingKey: KEY });
  const violations = await verifyAuditAnchorExport(pool, document, { signingKey: "wrong-key-0123456789abcdefghij" });
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /签名不匹配/);
});

test("核心场景：连锚点一起删，库内校验说干净，导出件抓到了", async () => {
  const document = await buildAuditAnchorExport(pool, { exportedBy: "ops-1", signingKey: KEY });
  assert.equal(document.anchorCount, 2);

  // 攻击者的动作：截断审计行，并把指向被删区间的锚点一并删掉。
  const tail = (await pool.query("SELECT chain_seq FROM audit_logs ORDER BY chain_seq DESC LIMIT 1")).rows[0];
  await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER ALL");
  await pool.query("ALTER TABLE audit_chain_anchors DISABLE TRIGGER ALL");
  await pool.query("DELETE FROM audit_logs WHERE chain_seq > $1", [Number(tail.chain_seq) - 4]);
  await pool.query("DELETE FROM audit_chain_anchors WHERE chain_seq > $1", [Number(tail.chain_seq) - 4]);
  await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER ALL");
  await pool.query("ALTER TABLE audit_chain_anchors ENABLE TRIGGER ALL");

  // 库内校验：干净。它只遍历库里还存在的锚点，被删掉的那个不会替自己发声。
  const inDatabase = await verifyAuditChainAnchors(pool);
  assert.deepEqual(inDatabase, [], "库内校验在这个场景下结构上就发现不了");

  // 库外导出件：抓到。遍历的是导出件里的锚点清单，攻击者碰不到它。
  const violations = await verifyAuditAnchorExport(pool, document, { signingKey: KEY });
  assert.ok(violations.length > 0, "导出件回验必须发现这次截断");
  assert.ok(
    violations.some((entry) => /锚点已从数据库中消失/.test(entry.reason)),
    `应报告锚点消失，实际：${violations.map((entry) => entry.reason).join("；")}`,
  );
});

test("无法识别的格式直接拒绝，不当作通过", async () => {
  const violations = await verifyAuditAnchorExport(pool, { format: "something-else", anchors: [], digest: "" }, { signingKey: KEY });
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /无法识别的导出件格式/);
});
