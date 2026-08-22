/**
 * 审计锚点的库外导出与回验。
 *
 * 0049 的锚点让「链尾被截断」在库内可被发现，但它有一个自己无法覆盖的盲区：
 * `verify_audit_chain_anchors()` **只遍历库里还存在的锚点**。攻击者把审计行和对应
 * 锚点一起删掉，那个函数会返回「干净」——被删掉的锚点不会替自己发声。
 *
 * 库外导出就是为了堵这个盲区：导出件保存在数据库角色够不着的地方，回验时以
 * **导出件里的锚点清单**为准去查库，而不是以库里现存的锚点为准。
 *
 * 说清楚它保护什么、不保护什么：
 * - **保护**：数据库侧的删除与改写（含把锚点一起删）。
 * - **不保护**：导出件本身被替换。配了 `AUDIT_ANCHOR_EXPORT_KEY` 时导出件带 HMAC
 *   签名，能挡住伪造；没配时导出件明确标注 `signed: false`，回验会说明这一点。
 *   把未签名的导出件说成「已保护」比没有导出更糟——那是虚假的安全感（INV-6）。
 */

import crypto from "node:crypto";
import type { Pool } from "pg";

import { canonicalJson } from "../packages/domain/src/canonical-hash.ts";
import type { AuditChainAnchor } from "./audit-chain-anchor.ts";

export const AUDIT_ANCHOR_EXPORT_FORMAT = "riverton-audit-anchor-export/v1";

export type AuditAnchorExport = {
  format: typeof AUDIT_ANCHOR_EXPORT_FORMAT;
  exportedAt: string;
  exportedBy: string;
  anchorCount: number;
  anchors: AuditChainAnchor[];
  /** 锚点清单的 SHA-256。改动清单里任何一个字段都会让它对不上。 */
  digest: string;
  /** 是否带签名。未签名的导出件只防库内篡改，不防导出件本身被替换。 */
  signed: boolean;
  signature: string | null;
};

function digestOf(anchors: AuditChainAnchor[]): string {
  // 用规范化 JSON：键序不影响摘要，两次导出同一批锚点必然得到同一个值。
  return crypto.createHash("sha256").update(canonicalJson(anchors)).digest("hex");
}

function signatureOf(digest: string, key: string | undefined): string | null {
  if (!key) return null;
  return crypto.createHmac("sha256", key).update(digest).digest("hex");
}

/**
 * 生成导出件。
 *
 * 一次导出**全部**锚点，不做增量。锚点数量以「链尾变化次数」计，量很小；
 * 而增量导出会引入「上一份导出件丢了怎么办」的新问题——那正是这套机制要避免的
 * 依赖关系。
 */
export async function buildAuditAnchorExport(
  database: Pool,
  input: { exportedBy: string; now?: Date; signingKey?: string },
): Promise<AuditAnchorExport> {
  // listAuditChainAnchors 有 200 上限（它服务于界面分页），这里要的是全量。
  const result = await database.query<{
    id: string; chain_seq: string; row_hash: Buffer;
    entry_count: string; anchored_at: Date; anchored_by: string;
  }>(`
    SELECT id, chain_seq, row_hash, entry_count, anchored_at, anchored_by
    FROM audit_chain_anchors
    ORDER BY chain_seq
  `);
  const anchors = result.rows.map((row): AuditChainAnchor => ({
    id: row.id,
    chainSeq: row.chain_seq,
    rowHashHex: row.row_hash.toString("hex"),
    entryCount: row.entry_count,
    anchoredAt: row.anchored_at.toISOString(),
    anchoredBy: row.anchored_by,
  }));

  const digest = digestOf(anchors);
  const signingKey = input.signingKey ?? process.env.AUDIT_ANCHOR_EXPORT_KEY;
  const signature = signatureOf(digest, signingKey);
  return {
    format: AUDIT_ANCHOR_EXPORT_FORMAT,
    exportedAt: (input.now ?? new Date()).toISOString(),
    exportedBy: input.exportedBy,
    anchorCount: anchors.length,
    anchors,
    digest,
    signed: signature !== null,
    signature,
  };
}

export type AuditAnchorExportViolation = {
  chainSeq: string | null;
  reason: string;
};

/**
 * 用导出件回验数据库。
 *
 * 遍历的是**导出件里的锚点**，不是库里现存的锚点——这正是它比
 * `verify_audit_chain_anchors()` 多出来的那一层：被删掉的锚点仍然会被检查。
 */
export async function verifyAuditAnchorExport(
  database: Pool,
  document: AuditAnchorExport,
  options: { signingKey?: string } = {},
): Promise<AuditAnchorExportViolation[]> {
  const violations: AuditAnchorExportViolation[] = [];

  if (document.format !== AUDIT_ANCHOR_EXPORT_FORMAT) {
    return [{ chainSeq: null, reason: `无法识别的导出件格式：${document.format}` }];
  }
  // 先验导出件自身。它若已被改动，后面的比对没有意义。
  if (digestOf(document.anchors) !== document.digest) {
    return [{ chainSeq: null, reason: "导出件的锚点清单与其摘要不一致（导出件被改动）" }];
  }
  const signingKey = options.signingKey ?? process.env.AUDIT_ANCHOR_EXPORT_KEY;
  if (document.signed) {
    if (!signingKey) {
      violations.push({ chainSeq: null, reason: "导出件带签名但未提供 AUDIT_ANCHOR_EXPORT_KEY，无法验签" });
    } else if (signatureOf(document.digest, signingKey) !== document.signature) {
      return [{ chainSeq: null, reason: "导出件签名不匹配（导出件被替换或密钥不对）" }];
    }
  }

  const currentCount = Number((await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_logs")).rows[0].count);

  for (const anchor of document.anchors) {
    const stored = (await database.query<{ row_hash: Buffer; entry_count: string }>(
      "SELECT row_hash, entry_count FROM audit_chain_anchors WHERE chain_seq = $1",
      [anchor.chainSeq],
    )).rows[0];

    if (!stored) {
      // 库内校验永远发现不了这一条：锚点没了，它就不在被遍历的集合里。
      violations.push({ chainSeq: anchor.chainSeq, reason: "锚点已从数据库中消失（锚点被删除）" });
    } else if (stored.row_hash.toString("hex") !== anchor.rowHashHex) {
      violations.push({ chainSeq: anchor.chainSeq, reason: "数据库中的锚点哈希与导出件不一致（锚点被改写）" });
    }

    const logRow = (await database.query<{ row_hash: Buffer }>(
      "SELECT row_hash FROM audit_logs WHERE chain_seq = $1", [anchor.chainSeq],
    )).rows[0];
    if (!logRow) {
      violations.push({ chainSeq: anchor.chainSeq, reason: "锚定的审计行已不存在（链尾被截断或该行被删除）" });
    } else if (logRow.row_hash.toString("hex") !== anchor.rowHashHex) {
      violations.push({ chainSeq: anchor.chainSeq, reason: "锚定行的哈希与导出件不一致（内容被改写）" });
    }

    if (currentCount < Number(anchor.entryCount)) {
      violations.push({
        chainSeq: anchor.chainSeq,
        reason: `审计行数由 ${anchor.entryCount} 降至 ${currentCount}（有行被删除）`,
      });
    }
  }
  return violations;
}
