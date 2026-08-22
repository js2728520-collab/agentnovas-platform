/**
 * 审计锚点的库外导出与回验（CLI）。
 *
 *   导出：node --experimental-strip-types scripts/export-audit-anchors.mjs export > anchors.json
 *   回验：node --experimental-strip-types scripts/export-audit-anchors.mjs verify anchors.json
 *
 * **导出件必须存到数据库角色够不着的地方**——存回同一台机器的同一个卷等于没导出。
 * 异地对象存储、离线介质、或另一台机器上的仓库都可以。
 *
 * 回验才是这套机制的价值所在。一份从没被回验过的导出件只是一个文件。
 */

import { readFileSync } from "node:fs";
import pg from "pg";

import {
  buildAuditAnchorExport,
  verifyAuditAnchorExport,
} from "../lib/audit-anchor-export.ts";
import { researchDatabaseUrl } from "../lib/postgres.ts";

const command = process.argv[2];
const connectionString = process.env.AUDIT_DATABASE_URL || researchDatabaseUrl();
if (!connectionString) throw new Error("需要 AUDIT_DATABASE_URL 或 DATABASE_URL");

const pool = new pg.Pool({ connectionString, max: 2, application_name: "agentnovas-audit-anchor-export" });

async function main() {
  if (command === "export") {
    const actor = process.env.AUDIT_EXPORT_ACTOR || `cli:${process.env.USER || "unknown"}`;
    const document = await buildAuditAnchorExport(pool, { exportedBy: actor });
    if (document.anchorCount === 0) {
      // 空导出件不是「已导出」。让它安静地成功会造出一份看起来有保护的空文件。
      process.stderr.write("库内没有任何锚点，没有可导出的内容。请先登记锚点。\n");
      process.exitCode = 1;
      return;
    }
    if (!document.signed) {
      process.stderr.write(
        "警告：未配置 AUDIT_ANCHOR_EXPORT_KEY，导出件未签名。\n" +
        "它仍能发现数据库侧的删除与改写，但无法证明导出件自身没有被替换。\n",
      );
    }
    // 导出动作本身进审计。谁在什么时候取走了锚点，是需要留痕的。
    await pool.query(
      `INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json)
       VALUES ($1, NULL, 'audit.anchors.exported', 'audit_chain_anchors', $2, $3)`,
      [crypto.randomUUID(), document.digest,
       JSON.stringify({ exportedBy: actor, anchorCount: document.anchorCount, signed: document.signed })],
    );
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }

  if (command === "verify") {
    const path = process.argv[3];
    if (!path) throw new Error("用法：verify <导出件路径>");
    const document = JSON.parse(readFileSync(path, "utf8"));
    const violations = await verifyAuditAnchorExport(pool, document);
    if (violations.length === 0) {
      process.stdout.write(`导出件回验通过：${document.anchorCount} 个锚点在库内全部对得上。\n`);
      if (!document.signed) {
        process.stdout.write("注意：该导出件未签名，只证明了数据库侧未被篡改。\n");
      }
      return;
    }
    for (const violation of violations) {
      process.stderr.write(`  ✗ chain_seq=${violation.chainSeq ?? "-"}：${violation.reason}\n`);
    }
    process.stderr.write(
      `\n回验失败：${violations.length} 处不一致。\n` +
      "注意库内的 verify_audit_chain_anchors() 可能仍然报告「干净」——它只遍历库里还\n" +
      "存在的锚点，被删掉的锚点不会替自己发声。以导出件为准。\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write("用法：export | verify <导出件路径>\n");
  process.exitCode = 2;
}

try {
  await main();
} finally {
  await pool.end().catch(() => {});
}
