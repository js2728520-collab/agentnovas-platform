import crypto from "node:crypto";
import type { Pool } from "pg";

/**
 * 审计链尾锚定。
 *
 * 0044 的哈希链能检出「改内容」与「删中间行」，但检不出**截断链尾**——
 * 把最后 N 行删掉，剩下的链依然自洽。链内校验无法自证「本该还有多少行」。
 *
 * 锚点把当时的链尾（chain_seq + row_hash + 总行数）记下来。之后校验时，
 * 被锚定的那个 chain_seq 若已不存在或哈希变了，就是截断或篡改。
 *
 * **边界**：锚点存在同一个库里。有完整写权限的人理论上可以连锚点一起删
 * （append-only 触发器让他必须先删触发器）。真正的防线是把锚点导出到库外——
 * 运维端提供导出，导出本身也进审计。这里负责让「截断可被发现」在库内成立。
 */

export type AuditChainAnchor = {
  id: string;
  chainSeq: string;
  rowHashHex: string;
  entryCount: string;
  anchoredAt: string;
  anchoredBy: string;
};

export type AuditChainAnchorViolation = {
  anchorId: string;
  chainSeq: string;
  reason: string;
};

/**
 * 登记一个新锚点。
 *
 * 链尾没变时不重复登记：`UNIQUE (chain_seq)` 会拦住，这里直接返回既有锚点。
 * 反复登记同一个链尾只会让归档变吵，不增加任何保护。
 */
export async function recordAuditChainAnchor(database: Pool, input: { anchoredBy: string }) {
  const tail = await database.query<{ chain_seq: string; row_hash: Buffer; entry_count: string }>(`
    SELECT a.chain_seq, a.row_hash, (SELECT count(*) FROM audit_logs) AS entry_count
    FROM audit_logs a
    ORDER BY a.chain_seq DESC
    LIMIT 1
  `);
  const row = tail.rows[0];
  // 空审计表没有链尾可锚。返回 null 而不是造一个零值锚点——
  // 一个假锚点会让「没有保护」看起来像「有保护」（INV-6）。
  if (!row) return null;

  const inserted = await database.query<{ id: string }>(`
    INSERT INTO audit_chain_anchors (id, chain_seq, row_hash, entry_count, anchored_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (chain_seq) DO NOTHING
    RETURNING id
  `, [crypto.randomUUID(), row.chain_seq, row.row_hash, row.entry_count, input.anchoredBy.slice(0, 160)]);

  return {
    chainSeq: row.chain_seq,
    entryCount: row.entry_count,
    rowHashHex: row.row_hash.toString("hex"),
    created: inserted.rows.length > 0,
  };
}

export async function listAuditChainAnchors(database: Pool, input: { limit: number }) {
  const result = await database.query<{
    id: string; chain_seq: string; row_hash: Buffer;
    entry_count: string; anchored_at: Date; anchored_by: string;
  }>(`
    SELECT id, chain_seq, row_hash, entry_count, anchored_at, anchored_by
    FROM audit_chain_anchors
    ORDER BY chain_seq DESC
    LIMIT $1
  `, [Math.max(1, Math.min(input.limit, 200))]);

  return result.rows.map((row): AuditChainAnchor => ({
    id: row.id,
    chainSeq: row.chain_seq,
    rowHashHex: row.row_hash.toString("hex"),
    entryCount: row.entry_count,
    anchoredAt: row.anchored_at.toISOString(),
    anchoredBy: row.anchored_by,
  }));
}

/** 空数组表示没有发现截断或篡改。判定在数据库函数里，与链本身同源。 */
export async function verifyAuditChainAnchors(database: Pool): Promise<AuditChainAnchorViolation[]> {
  const result = await database.query<{ anchor_id: string; chain_seq: string; reason: string }>(
    "SELECT anchor_id, chain_seq, reason FROM verify_audit_chain_anchors()",
  );
  return result.rows.map((row) => ({
    anchorId: row.anchor_id,
    chainSeq: row.chain_seq,
    reason: row.reason,
  }));
}
