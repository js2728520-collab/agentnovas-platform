import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { assertBalancedPostings, normalizeDecimalString } from "./ledger.ts";
import { ResearchApiError } from "./research-errors.ts";

export type CommercialLedgerPosting = { accountId: string; side: "debit" | "credit"; amount: string };

function signedDecimal(value:string){
  const match=/^(-)?(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim());
  if(!match)throw new Error("INVALID_DECIMAL_AMOUNT");
  const normalized=normalizeDecimalString(`${match[2]}${match[3]?`.${match[3]}`:""}`);
  return match[1]&&normalized!=="0"?`-${normalized}`:normalized;
}

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
  transactionType: "membership_purchase" | "performance_fee_payment" | "correction";
  sourceType: string;
  sourceId: string;
  currency: string;
  idempotencyKey: string;
  requestId: string;
  createdByUserId: string;
  postings: CommercialLedgerPosting[];
  metadata?: Record<string, unknown>;
  reversalOfTransactionId?: string;
  walletMutation?: {userId:string;availableDelta:string;frozenDelta:string};
  audit?: {action:string;subjectType:string;subjectId:string;before?:Record<string,unknown>;after?:Record<string,unknown>};
  outbox?: {userId:string;category:string;templateKey:string;payload:Record<string,unknown>;dedupeKey:string};
}) {
  assertBalancedPostings(input.postings);
  const existing = await client.query<{ id: string;transaction_type:string;source_type:string;source_id:string;currency:string;created_by_user_id:string|null }>(
    `SELECT id,transaction_type,source_type,source_id,currency,created_by_user_id FROM ledger_transactions WHERE idempotency_key = $1 FOR SHARE`,
    [input.idempotencyKey],
  );
  if (existing.rows[0]) {
    const row=existing.rows[0];
    if(row.transaction_type!==input.transactionType||row.source_type!==input.sourceType||row.source_id!==input.sourceId||row.currency!==input.currency||row.created_by_user_id!==input.createdByUserId)
      throw new ResearchApiError("IDEMPOTENCY_KEY_COLLISION","账本幂等键已绑定其他交易",409);
    return { id: row.id, created: false };
  }
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
      (id, transaction_type, source_type, source_id, currency, status, idempotency_key, request_id,
       ledger_version, reversal_of_transaction_id, metadata_json, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,1,$8,$9::jsonb,$10)
  `, [transactionId, input.transactionType, input.sourceType, input.sourceId, input.currency,
    input.idempotencyKey, input.requestId, input.reversalOfTransactionId ?? null,
    JSON.stringify(input.metadata ?? {}), input.createdByUserId]);
  for (const posting of input.postings) {
    await client.query(`
      INSERT INTO ledger_postings (id, transaction_id, account_id, side, amount, currency)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [randomUUID(), transactionId, posting.accountId, posting.side, normalizeDecimalString(posting.amount), input.currency]);
  }
  if(input.walletMutation){
    const availableDelta=signedDecimal(input.walletMutation.availableDelta);
    const frozenDelta=signedDecimal(input.walletMutation.frozenDelta);
    await client.query(`INSERT INTO wallet_balances(id,user_id,currency) VALUES($1,$2,$3) ON CONFLICT(user_id,currency) DO NOTHING`,[randomUUID(),input.walletMutation.userId,input.currency]);
    await client.query(`SELECT id FROM wallet_balances WHERE user_id=$1 AND currency=$2 FOR UPDATE`,[input.walletMutation.userId,input.currency]);
    const wallet=await client.query<{id:string;available_amount:string;frozen_amount:string;version:string}>(`UPDATE wallet_balances
      SET available_amount=available_amount+$3::numeric,frozen_amount=frozen_amount+$4::numeric,version=version+1,updated_at=now()
      WHERE user_id=$1 AND currency=$2 AND available_amount+$3::numeric>=0 AND frozen_amount+$4::numeric>=0
      RETURNING id,available_amount::text,frozen_amount::text,version::text`,[input.walletMutation.userId,input.currency,availableDelta,frozenDelta]);
    if(!wallet.rows[0])throw new Error("WALLET_BALANCE_INSUFFICIENT");
    await client.query(`INSERT INTO wallet_balance_versions(id,wallet_balance_id,ledger_transaction_id,available_amount,frozen_amount,version)
      VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),wallet.rows[0].id,transactionId,wallet.rows[0].available_amount,wallet.rows[0].frozen_amount,wallet.rows[0].version]);
  }
  if(input.audit){
    await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),input.createdByUserId,input.audit.action,input.audit.subjectType,input.audit.subjectId,
      JSON.stringify(input.audit.before??{}),JSON.stringify(input.audit.after??{})]);
  }
  if(input.outbox){
    await client.query(`INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key)
      VALUES($1,$2,'in_app',$3,$4,$5,'queued',$6,$7) ON CONFLICT(dedupe_key) DO NOTHING`,
    [randomUUID(),input.outbox.userId,input.outbox.category,input.outbox.templateKey,JSON.stringify(input.outbox.payload),new Date().toISOString(),input.outbox.dedupeKey]);
  }
  await client.query(`UPDATE ledger_transactions SET status='posted' WHERE id=$1 AND status='pending'`,[transactionId]);
  return { id: transactionId, created: true };
}
