import type { Pool } from "pg";

import {
  customerPiiAuditPayload,
  type CustomerPiiCategory,
  type OperationsCustomerPiiRaw,
  type OperationsExchangeAccountPii,
  type OperationsOpenPositionPii,
} from "./operations-customer-pii.ts";
import type { DataScope } from "./rbac.ts";

type CustomerPiiRow = {
  customer_id: string;
  email: string | null;
  phone: string | null;
  telegram: string | null;
  whatsapp: string | null;
  registration_ip_address: string | null;
  last_login_ip_address: string | null;
  last_login_user_agent: string | null;
  cumulative_deposit_usdt: string | null;
  cumulative_spend_usdt: string | null;
  exchange_accounts: OperationsExchangeAccountPii[] | null;
  open_positions: OperationsOpenPositionPii[] | null;
};

const EMPTY_PII: OperationsCustomerPiiRaw = {
  email: null,
  phone: null,
  telegram: null,
  whatsapp: null,
  registrationIpAddress: null,
  lastLoginIpAddress: null,
  lastLoginUserAgent: null,
  cumulativeDepositUsdt: "0",
  cumulativeSpendUsdt: "0",
  exchangeAccounts: [],
  openPositions: [],
};

export async function loadOperationsCustomerPii(pool: Pool, customerIds: readonly string[]) {
  if (!customerIds.length) return new Map<string, OperationsCustomerPiiRaw>();
  const result = await pool.query<CustomerPiiRow>(`
    SELECT customer.id AS customer_id,customer.email,customer.phone,
           channels.telegram,channels.whatsapp,
           registration.ip_address AS registration_ip_address,
           latest_session.ip_address AS last_login_ip_address,
           latest_session.user_agent AS last_login_user_agent,
           COALESCE(deposits.total,'0') AS cumulative_deposit_usdt,
           COALESCE(spend.total,'0') AS cumulative_spend_usdt,
           COALESCE(accounts.items,'[]'::jsonb) AS exchange_accounts,
           COALESCE(positions.items,'[]'::jsonb) AS open_positions
      FROM users customer
      LEFT JOIN LATERAL (
        SELECT max(destination) FILTER (WHERE channel='telegram' AND status='verified') AS telegram,
               max(destination) FILTER (WHERE channel='whatsapp' AND status='verified') AS whatsapp
          FROM notification_channels WHERE user_id=customer.id
      ) channels ON TRUE
      LEFT JOIN LATERAL (
        SELECT ip_address FROM audit_logs
         WHERE actor_user_id=customer.id AND action='customer.registered'
         ORDER BY created_at ASC,id ASC LIMIT 1
      ) registration ON TRUE
      LEFT JOIN LATERAL (
        SELECT ip_address,user_agent FROM sessions
         WHERE user_id=customer.id
         ORDER BY COALESCE(last_seen_at,created_at::timestamptz) DESC,id DESC LIMIT 1
      ) latest_session ON TRUE
      LEFT JOIN LATERAL (
        SELECT sum(credited_amount)::text AS total FROM deposit_orders
         WHERE user_id=customer.id AND order_status='CREDITED'
      ) deposits ON TRUE
      LEFT JOIN LATERAL (
        SELECT sum(amount_usdt)::text AS total FROM revenue_events
         WHERE customer_id=customer.id AND status='confirmed'
      ) spend ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id',account.id,'exchange',account.exchange,'label',account.label,
          'environment',account.environment,'status',account.status,
          'canRead',account.can_read::boolean,'canTrade',account.can_trade::boolean,
          'lastCheckedAt',account.last_checked_at
        ) ORDER BY account.created_at DESC,account.id DESC) AS items
          FROM exchange_accounts account WHERE account.customer_id=customer.id
      ) accounts ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id',trade.id,'exchangeAccountId',trade.exchange_account_id,
          'symbol',trade.symbol,'side',trade.side,'quantity',trade.quantity::text,
          'entryValueUsdt',trade.entry_value_usdt::text,'openedAt',trade.opened_at
        ) ORDER BY trade.opened_at DESC NULLS LAST,trade.id DESC) AS items
          FROM trades trade
         WHERE trade.customer_id=customer.id AND trade.closed_at IS NULL
           AND trade.status IN ('filled','closing')
      ) positions ON TRUE
     WHERE customer.id=ANY($1::text[]) AND customer.role='customer'
  `, [[...new Set(customerIds)]]);
  return new Map(result.rows.map((row) => [row.customer_id, {
    email: row.email,
    phone: row.phone,
    telegram: row.telegram,
    whatsapp: row.whatsapp,
    registrationIpAddress: row.registration_ip_address,
    lastLoginIpAddress: row.last_login_ip_address,
    lastLoginUserAgent: row.last_login_user_agent,
    cumulativeDepositUsdt: row.cumulative_deposit_usdt ?? "0",
    cumulativeSpendUsdt: row.cumulative_spend_usdt ?? "0",
    exchangeAccounts: row.exchange_accounts ?? [],
    openPositions: row.open_positions ?? [],
  }]));
}

export function operationsCustomerPiiOrEmpty(
  rows: ReadonlyMap<string, OperationsCustomerPiiRaw>,
  customerId: string,
) {
  return rows.get(customerId) ?? { ...EMPTY_PII, exchangeAccounts: [], openPositions: [] };
}

export async function recordOperationsCustomerPiiAudit(pool: Pool, input: {
  actorUserId: string;
  action: "customer.pii_viewed" | "customer.pii_export_generated" | "customer.pii_export_downloaded";
  subjectType: "customer" | "customer_collection";
  subjectId: string;
  categories: readonly CustomerPiiCategory[];
  reason: string;
  scope: DataScope;
  organizationIds: readonly string[];
  resultCount: number;
  requestId: string | null;
}) {
  const payload = customerPiiAuditPayload(input);
  await pool.query(`
    INSERT INTO audit_logs(
      id,actor_user_id,action,subject_type,subject_id,after_json,request_id,created_at
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,now())
  `, [
    crypto.randomUUID(), input.actorUserId, input.action, input.subjectType,
    input.subjectId, JSON.stringify(payload), input.requestId,
  ]);
}
