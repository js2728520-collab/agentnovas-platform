-- Riverton commercial ledger invariants. Ledger rows are immutable; reversals are new rows.
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS ledger_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reversal_of_transaction_id text REFERENCES ledger_transactions(id) ON DELETE RESTRICT;

UPDATE ledger_transactions SET request_id = id WHERE request_id IS NULL;
ALTER TABLE ledger_transactions ALTER COLUMN request_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_transactions_request_id
  ON ledger_transactions (request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_transactions_source_idempotency
  ON ledger_transactions (source_type, source_id, transaction_type, currency);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_transactions_one_reversal
  ON ledger_transactions (reversal_of_transaction_id)
  WHERE reversal_of_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_platform_unique
  ON ledger_accounts (account_type, currency)
  WHERE owner_user_id IS NULL AND owner_organization_id IS NULL;

CREATE OR REPLACE FUNCTION enforce_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_APPEND_ONLY' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_transactions_append_only ON ledger_transactions;
CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_ledger_append_only();

DROP TRIGGER IF EXISTS ledger_postings_append_only ON ledger_postings;
CREATE TRIGGER ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION enforce_ledger_append_only();

CREATE OR REPLACE FUNCTION validate_ledger_transaction_balance() RETURNS trigger AS $$
DECLARE
  target_transaction_id text := COALESCE(to_jsonb(NEW)->>'transaction_id', to_jsonb(NEW)->>'id');
  transaction_currency text;
  posting_count bigint;
  debit_total numeric(36,18);
  credit_total numeric(36,18);
  currency_mismatch bigint;
BEGIN
  SELECT currency INTO transaction_currency FROM ledger_transactions WHERE id = target_transaction_id;
  SELECT count(*), COALESCE(sum(amount) FILTER (WHERE side = 'debit'), 0),
         COALESCE(sum(amount) FILTER (WHERE side = 'credit'), 0),
         count(*) FILTER (WHERE lp.currency <> transaction_currency OR la.currency <> transaction_currency)
    INTO posting_count, debit_total, credit_total, currency_mismatch
  FROM ledger_postings lp JOIN ledger_accounts la ON la.id = lp.account_id
  WHERE lp.transaction_id = target_transaction_id;
  IF posting_count < 2 OR debit_total <> credit_total OR debit_total <= 0 THEN
    RAISE EXCEPTION 'LEDGER_NOT_BALANCED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF currency_mismatch > 0 THEN
    RAISE EXCEPTION 'LEDGER_CURRENCY_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_postings_balanced ON ledger_postings;
CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_ledger_transaction_balance();

DROP TRIGGER IF EXISTS ledger_transactions_balanced ON ledger_transactions;
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_ledger_transaction_balance();
