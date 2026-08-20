import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { assertBalancedPostings, normalizeDecimalString } from "./ledger.ts";

export type CommercialLedgerPosting = { accountId: string; side: "debit" | "credit"; amount: string };

export async function ensurePlatformLedgerAccount(client: PoolClient, accountType: "platform_deposit_clearing" | "platform_fee", currency: string) {
  const id = `ledger-platform-${accountType}-${currency.toLowerCase()}`;
  await client.query(`
    INSERT INTO ledger_accounts (id, account_type, currency)
    VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING
  `, [id, accountType, currency]);
  const row = await client.query<{ id: string }>(`
    SELECT id FROM ledger_accounts
    WHERE owner_user_id IS NULL AND owner_organization_id IS NULL AND account_type = $1 AND currency = $2
    FOR UPDATE
  `, [accountType, currency]);
  if (!row.rows[0]) throw new Error("LEDGER_PLATFORM_ACCOUNT_MISSING");
  return row.rows[0].id;
}

export async function postCommercialLedgerTransaction(client: PoolClient, input: {
  transactionType: "membership_purchase" | "correction";
  sourceType: string;
  sourceId: string;
  currency: string;
  idempotencyKey: string;
  requestId: string;
  createdByUserId: string;
  postings: CommercialLedgerPosting[];
  metadata?: Record<string, unknown>;
  reversalOfTransactionId?: string;
}) {
  assertBalancedPostings(input.postings);
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ledger_transactions WHERE idempotency_key = $1 OR request_id = $2 FOR SHARE`,
    [input.idempotencyKey, input.requestId],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  const accountIds = [...new Set(input.postings.map(posting => posting.accountId))].sort();
  const accounts = await client.query<{ id: string; currency: string; status: string }>(
    `SELECT id, currency, status FROM ledger_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
    [accountIds],
  );
  if (accounts.rows.length !== accountIds.length || accounts.rows.some(row => row.currency !== input.currency || row.status !== "active")) {
    throw new Error("LEDGER_ACCOUNT_INVALID");
  }
  const transactionId = randomUUID();
  await client.query(`
    INSERT INTO ledger_transactions
      (id, transaction_type, source_type, source_id, currency, idempotency_key, request_id,
       ledger_version, reversal_of_transaction_id, metadata_json, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9::jsonb,$10)
  `, [transactionId, input.transactionType, input.sourceType, input.sourceId, input.currency,
    input.idempotencyKey, input.requestId, input.reversalOfTransactionId ?? null,
    JSON.stringify(input.metadata ?? {}), input.createdByUserId]);
  for (const posting of input.postings) {
    await client.query(`
      INSERT INTO ledger_postings (id, transaction_id, account_id, side, amount, currency)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [randomUUID(), transactionId, posting.accountId, posting.side, normalizeDecimalString(posting.amount), input.currency]);
  }
  return { id: transactionId, created: true };
}
