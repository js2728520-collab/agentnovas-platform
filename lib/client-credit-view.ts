import type { Pool, QueryResultRow } from "pg";

import type { AiCreditBalance } from "../packages/contracts/src/commercial-beta.ts";

type CreditDatabase = Pick<Pool, "query">;

type CreditBalanceRow = QueryResultRow & {
  available: string;
  reserved: string;
  version: string;
  updated_at: string;
  lifetime_granted: string;
  lifetime_consumed: string;
};

export async function readClientCreditBalance(database: CreditDatabase, userId: string): Promise<AiCreditBalance> {
  const result = await database.query<CreditBalanceRow>(`
    SELECT
      a.available_credits::text AS available,
      a.reserved_credits::text AS reserved,
      a.version::text AS version,
      a.updated_at::text AS updated_at,
      COALESCE(sum(e.available_delta) FILTER (WHERE e.entry_type = 'grant'), 0)::text AS lifetime_granted,
      COALESCE(-sum(e.available_delta + e.reserved_delta) FILTER (WHERE e.entry_type = 'settle'), 0)::text AS lifetime_consumed
    FROM ai_credit_accounts a
    LEFT JOIN ai_credit_ledger_entries e ON e.account_id = a.id
    WHERE a.user_id = $1
    GROUP BY a.id
  `, [userId]);
  const row = result.rows[0];
  const updatedAt = row?.updated_at ? new Date(row.updated_at) : null;
  if (updatedAt && Number.isNaN(updatedAt.getTime())) throw new Error("Invalid credit timestamp");
  return {
    available: row?.available ?? "0",
    reserved: row?.reserved ?? "0",
    lifetimeGranted: row?.lifetime_granted ?? "0",
    lifetimeConsumed: row?.lifetime_consumed ?? "0",
    version: row?.version ?? "0",
    updatedAt: updatedAt?.toISOString() ?? null,
  };
}
