export type DemoAccountSafeRow = {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  kill_switch_enabled: boolean;
  has_api_key: boolean;
  has_secret: boolean;
  has_passphrase: boolean;
  last_verified_at: Date | string | null;
  last_verification_status: string | null;
  verification_fresh: boolean;
  updated_at: Date | string;
  daily_notional: string;
  daily_intent_count: string;
  latest_receipt_status: string | null;
  latest_receipt_filled_quote: string | null;
  latest_receipt_fee: string | null;
  latest_receipt_at: Date | string | null;
};

export type DemoCardSafeRow = {
  provider: string;
  strategy_code: string;
  kill_switch_enabled: boolean;
  updated_at: Date | string;
};

function timestamp(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

export function maintenanceDemoAccountDto(
  row: DemoAccountSafeRow,
  cards: DemoCardSafeRow[],
) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    configured:
      row.has_api_key &&
      row.has_secret &&
      (row.provider !== "okx" || row.has_passphrase),
    hasApiKey: row.has_api_key,
    hasSecret: row.has_secret,
    hasPassphrase: row.has_passphrase,
    enabled: row.enabled,
    killSwitchEnabled: row.kill_switch_enabled,
    lastVerifiedAt: timestamp(row.last_verified_at),
    lastVerificationStatus: row.last_verification_status,
    verificationFresh: row.verification_fresh,
    updatedAt: timestamp(row.updated_at)!,
    dailyNotional: row.daily_notional,
    dailyIntentCount: Number(row.daily_intent_count),
    latestReceipt: row.latest_receipt_status
      ? {
          status: row.latest_receipt_status,
          filledQuoteUsdt: row.latest_receipt_filled_quote ?? "0",
          feeUsdt: row.latest_receipt_fee,
          observedAt: timestamp(row.latest_receipt_at)!,
        }
      : null,
    cards: ["ai_conservative", "ai_balanced", "ai_aggressive"].map(
      (strategyCode) => {
        const card = cards.find(
          (candidate) =>
            candidate.provider === row.provider &&
            candidate.strategy_code === strategyCode,
        );
        return {
          strategyCode,
          killSwitchEnabled: card?.kill_switch_enabled ?? false,
          updatedAt: card ? timestamp(card.updated_at) : null,
        };
      },
    ),
  };
}

export async function loadMaintenanceDemoSafeView(database: Queryable) {
  const [accounts, cards] = await Promise.all([
    database.query<DemoAccountSafeRow>(`
      SELECT account.id,account.provider,account.label,account.enabled,
             account.kill_switch_enabled,account.has_api_key,account.has_secret,
             account.has_passphrase,account.last_verified_at,
             account.last_verification_status,account.updated_at,
             account.last_verification_status='passed'
               AND account.last_verified_at >= now() - interval '15 minutes'
               AS verification_fresh,
             COALESCE(today.daily_notional,0)::text AS daily_notional,
             COALESCE(today.daily_intent_count,0)::text AS daily_intent_count,
             latest.status AS latest_receipt_status,
             latest.filled_quote_usdt::text AS latest_receipt_filled_quote,
             latest.fee_usdt::text AS latest_receipt_fee,
             latest.observed_at AS latest_receipt_at
      FROM platform_demo_accounts_safe account
      LEFT JOIN LATERAL (
        SELECT sum(intent.quote_amount_usdt) AS daily_notional,
               count(*) AS daily_intent_count
        FROM platform_demo_order_intents intent
        WHERE intent.provider=account.provider
          AND intent.created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AND intent.created_at < (date_trunc('day',now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
      ) today ON true
      LEFT JOIN LATERAL (
        SELECT receipt.status,receipt.filled_quote_usdt,receipt.fee_usdt,
               receipt.observed_at
        FROM platform_demo_execution_receipts receipt
        WHERE receipt.provider=account.provider
        ORDER BY receipt.observed_at DESC,receipt.id DESC
        LIMIT 1
      ) latest ON true
      ORDER BY account.provider
    `),
    database.query<DemoCardSafeRow>(`
      SELECT provider,strategy_code,kill_switch_enabled,updated_at
      FROM platform_demo_card_controls
      ORDER BY provider,strategy_code
    `),
  ]);
  return accounts.rows.map((account) =>
    maintenanceDemoAccountDto(account, cards.rows),
  );
}
import type { QueryResult, QueryResultRow } from "pg";

type Queryable = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
};
