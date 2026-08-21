import type { QueryResult, QueryResultRow } from "pg";

import {
  clientDemoProviderCatalog,
  type ClientDemoCardStatus,
  type ClientDemoProvider,
  type ClientDemoProviderStatus,
  type ClientDemoReceiptStatus,
  type ClientDemoSummary,
  type OfficialStrategyCode,
} from "../packages/contracts/src/commercial-beta.ts";

type Queryable = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
};

type ProviderRow = {
  provider: string;
  enabled: boolean;
  kill_switch_enabled: boolean;
  last_verified_at: Date | string | null;
  last_verification_status: string | null;
};

type CardEvidenceRow = {
  provider: string;
  strategy_code: string;
  execution_status: string;
  last_tested_at: Date | string | null;
  receipt_status: string | null;
  receipt_observed_at: Date | string | null;
};

const strategyCodes = [
  "ai_conservative",
  "ai_balanced",
  "ai_aggressive",
] as const satisfies readonly OfficialStrategyCode[];

const databaseProviderByPublicProvider = {
  OKX: "okx",
  BINANCE: "binance",
  BYBIT: "bybit",
} as const satisfies Record<ClientDemoProvider, string>;

const databaseProviders = clientDemoProviderCatalog.map(
  ({ provider }) => databaseProviderByPublicProvider[provider],
);

const cardStatuses = new Set<ClientDemoCardStatus>([
  "PENDING",
  "RUNNING",
  "UNKNOWN",
  "RETRY_WAIT",
  "RECONCILE_WAIT",
  "FILLED",
  "CANCELLED",
  "FAILED",
  "QUARANTINED",
]);

const receiptStatuses = new Set<ClientDemoReceiptStatus>([
  "ACCEPTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELLED",
  "REJECTED",
]);

function timestamp(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestTimestamp(...values: Array<string | null>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function providerStatus(row: ProviderRow | undefined): ClientDemoProviderStatus {
  if (!row) return "NOT_CONFIGURED";
  if (row.kill_switch_enabled) return "PAUSED";
  if (!row.enabled) return "DISABLED";
  if (row.last_verification_status === "failed") return "VERIFICATION_FAILED";
  if (row.last_verification_status === "passed" && timestamp(row.last_verified_at)) return "VERIFIED";
  return "UNVERIFIED";
}

function cardStatus(row: CardEvidenceRow | undefined, paused: boolean): ClientDemoCardStatus {
  if (paused) return "PAUSED";
  if (!row) return "NOT_TESTED";
  const status = row.execution_status.toUpperCase() as ClientDemoCardStatus;
  return cardStatuses.has(status) ? status : "UNKNOWN";
}

function receiptSummary(row: CardEvidenceRow | undefined) {
  const observedAt = timestamp(row?.receipt_observed_at);
  if (!row?.receipt_status || !observedAt) return null;
  const status = row.receipt_status.toUpperCase() as ClientDemoReceiptStatus;
  if (!receiptStatuses.has(status)) return null;
  return { status, observedAt };
}

export async function loadClientDemoSummary(database: Queryable): Promise<ClientDemoSummary> {
  const [accounts, evidence] = await Promise.all([
    database.query<ProviderRow>(`
      SELECT provider,enabled,kill_switch_enabled,last_verified_at,last_verification_status
      FROM platform_demo_accounts_safe
      WHERE provider=ANY($1::text[])
      ORDER BY provider
    `, [databaseProviders]),
    database.query<CardEvidenceRow>(`
      SELECT DISTINCT ON (intent.provider,intent.strategy_code)
             intent.provider,intent.strategy_code,intent.status AS execution_status,
             GREATEST(intent.updated_at,receipt.observed_at) AS last_tested_at,
             receipt.status AS receipt_status,
             receipt.observed_at AS receipt_observed_at
      FROM platform_demo_order_intents intent
      LEFT JOIN LATERAL (
        SELECT execution.status,execution.observed_at
        FROM platform_demo_execution_receipts execution
        WHERE execution.intent_id=intent.id
        ORDER BY execution.observed_at DESC,execution.id DESC
        LIMIT 1
      ) receipt ON true
      WHERE intent.provider=ANY($1::text[])
        AND intent.strategy_code=ANY($2::text[])
      ORDER BY intent.provider,intent.strategy_code,intent.created_at DESC,intent.id DESC
    `, [
      databaseProviders,
      strategyCodes,
    ]),
  ]);

  return {
    customerImpact: false,
    demoFailureAffectsPaper: false,
    providers: clientDemoProviderCatalog.map((provider) => {
      const databaseProvider = databaseProviderByPublicProvider[provider.provider];
      const account = accounts.rows.find((row) => row.provider === databaseProvider);
      const paused = account?.kill_switch_enabled ?? false;
      const cards = strategyCodes.map((strategyCode) => {
        const row = evidence.rows.find((candidate) =>
          candidate.provider === databaseProvider && candidate.strategy_code === strategyCode,
        );
        return {
          strategyCode,
          status: cardStatus(row, paused),
          lastTestedAt: timestamp(row?.last_tested_at),
          receiptSummary: receiptSummary(row),
        };
      });
      return {
        provider: provider.provider,
        environment: provider.environment,
        status: providerStatus(account),
        lastTestedAt: latestTimestamp(
          timestamp(account?.last_verified_at),
          ...cards.map((card) => card.lastTestedAt),
        ),
        cards,
      };
    }),
  };
}
