import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { Pool, PoolClient } from "pg";

type MigrationTableResult = {
  tableName: string;
  sourceRowCount: number;
  targetRowCount: number;
  sourceSha256: string;
  targetSha256: string;
  verified: boolean;
};

function safeIdentifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`不安全的数据库标识符：${value}`);
  return `"${value}"`;
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `base64:${Buffer.from(value).toString("base64")}`;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function checksumRows(rows: Record<string, unknown>[], columns: string[]) {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(JSON.stringify(columns.map((column) => canonicalValue(row[column]))));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readVerifiedBatch(database: Pool, batchId: string) {
  const batch = await database.query<{ status: string }>(
    "SELECT status FROM migration_batches WHERE id = $1",
    [batchId],
  );
  if (batch.rows[0]?.status !== "verified") return null;
  const checks = await database.query<{
    table_name: string;
    source_row_count: string;
    target_row_count: string;
    source_sha256: string;
    target_sha256: string;
    verified: boolean;
  }>(`
    SELECT * FROM migration_table_checksums
    WHERE migration_batch_id = $1
    ORDER BY table_name
  `, [batchId]);
  return {
    id: batchId,
    status: "verified" as const,
    tables: checks.rows.map((row) => ({
      tableName: row.table_name,
      sourceRowCount: Number(row.source_row_count),
      targetRowCount: Number(row.target_row_count),
      sourceSha256: row.source_sha256,
      targetSha256: row.target_sha256,
      verified: row.verified,
    })),
  };
}

function sourceTables(source: DatabaseSync) {
  const rows = source.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return rows.map((row) => row.name).filter((name) => !name.startsWith("_cf_"));
}

function tableShape(source: DatabaseSync, tableName: string) {
  const table = safeIdentifier(tableName);
  const columns = source.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  if (!columns.length) throw new Error(`${tableName} 没有可迁移字段`);
  const names = columns.map((column) => column.name);
  names.forEach(safeIdentifier);
  const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  return { names, order: primary.length ? primary : names };
}

function sourceRows(source: DatabaseSync, tableName: string, columns: string[], order: string[]) {
  const selected = columns.map(safeIdentifier).join(", ");
  const ordered = order.map(safeIdentifier).join(", ");
  const rows = source.prepare(`SELECT ${selected} FROM ${safeIdentifier(tableName)} ORDER BY ${ordered}`).all();
  return rows as unknown as Record<string, unknown>[];
}

async function insertRows(client: PoolClient, tableName: string, columns: string[], rows: Record<string, unknown>[]) {
  const table = safeIdentifier(tableName);
  const columnSql = columns.map(safeIdentifier).join(", ");
  const chunkSize = 250;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => `(${columns.map((column) => {
      values.push(row[column]);
      return `$${values.length}`;
    }).join(", ")})`);
    await client.query(
      `INSERT INTO ${table} (${columnSql}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
      values,
    );
  }
}

async function assertEmptyTarget(client: PoolClient, tableName: string) {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${safeIdentifier(tableName)}`,
  );
  if (Number(result.rows[0]?.count || 0) !== 0) {
    throw new Error(`${tableName} 目标表不是空表，拒绝合并迁移`);
  }
}

async function targetRows(client: PoolClient, tableName: string, columns: string[], order: string[]) {
  const selected = columns.map(safeIdentifier).join(", ");
  const ordered = order.map(safeIdentifier).join(", ");
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${selected} FROM ${safeIdentifier(tableName)} ORDER BY ${ordered}`,
  );
  return result.rows;
}

export async function migrateLegacySqliteDatabase(options: {
  sqlitePath: string;
  database: Pool;
  batchId: string;
  sourceRef: string;
}) {
  if (!options.sqlitePath || !options.batchId || !options.sourceRef) throw new Error("迁移参数不完整");
  const existing = await readVerifiedBatch(options.database, options.batchId);
  if (existing) return existing;

  const source = new DatabaseSync(options.sqlitePath, { readOnly: true });
  const client = await options.database.connect();
  const results: MigrationTableResult[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO migration_batches (id, source_kind, source_ref, status)
      VALUES ($1, 'legacy_sqlite', $2, 'running')
      ON CONFLICT (id) DO UPDATE
      SET source_ref = EXCLUDED.source_ref, status = 'running', error_message = NULL
    `, [options.batchId, options.sourceRef]);

    for (const tableName of sourceTables(source)) {
      const { names, order } = tableShape(source, tableName);
      const fromSource = sourceRows(source, tableName, names, order);
      try {
        await assertEmptyTarget(client, tableName);
        await insertRows(client, tableName, names, fromSource);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "未知错误";
        throw new Error(`${tableName} 导入失败：${detail}`);
      }
      const fromTarget = await targetRows(client, tableName, names, order);
      const sourceSha256 = checksumRows(fromSource, names);
      const targetSha256 = checksumRows(fromTarget, names);
      const verified = fromSource.length === fromTarget.length && sourceSha256 === targetSha256;
      if (!verified) throw new Error(`${tableName} 行数或 SHA-256 核对失败`);
      const result = {
        tableName,
        sourceRowCount: fromSource.length,
        targetRowCount: fromTarget.length,
        sourceSha256,
        targetSha256,
        verified,
      };
      results.push(result);
      await client.query(`
        INSERT INTO migration_table_checksums (
          migration_batch_id, table_name, source_row_count, target_row_count,
          source_sha256, target_sha256, verified
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (migration_batch_id, table_name) DO UPDATE SET
          source_row_count = EXCLUDED.source_row_count,
          target_row_count = EXCLUDED.target_row_count,
          source_sha256 = EXCLUDED.source_sha256,
          target_sha256 = EXCLUDED.target_sha256,
          verified = EXCLUDED.verified
      `, [
        options.batchId,
        tableName,
        result.sourceRowCount,
        result.targetRowCount,
        result.sourceSha256,
        result.targetSha256,
        result.verified,
      ]);
    }

    await client.query(`
      UPDATE migration_batches
      SET status = 'verified', completed_at = now(), error_message = NULL
      WHERE id = $1
    `, [options.batchId]);
    await client.query("COMMIT");
    return { id: options.batchId, status: "verified" as const, tables: results };
  } catch (error) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message.slice(0, 1_000) : "迁移失败";
    await options.database.query(`
      INSERT INTO migration_batches (id, source_kind, source_ref, status, completed_at, error_message)
      VALUES ($1, 'legacy_sqlite', $2, 'failed', now(), $3)
      ON CONFLICT (id) DO UPDATE SET
        status = 'failed', completed_at = now(), error_message = EXCLUDED.error_message
    `, [options.batchId, options.sourceRef, message]);
    throw error;
  } finally {
    client.release();
    source.close();
  }
}
