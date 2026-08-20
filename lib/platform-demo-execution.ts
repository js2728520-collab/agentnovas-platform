import type { Pool, PoolClient } from "pg";

import { decryptIntegrationSecret } from "./integration-credentials.ts";
import {
  createPlatformDemoAdapter,
  createPlatformDemoFetchTransport,
  deterministicDemoClientOrderId,
  PlatformDemoResponseError,
  type PlatformDemoAdapter,
  type PlatformDemoProvider,
} from "./platform-demo-adapters.ts";
import type { OfficialTradingHallStrategy } from "../packages/contracts/src/trading-hall.ts";

type Queryable = Pick<Pool | PoolClient, "query">;
type StrategyCode = OfficialTradingHallStrategy["code"];

export class PlatformDemoIntentIdempotencyConflictError extends Error {
  constructor() {
    super("同一 provider/card/round 已用于不同的 Demo 意图");
    this.name = "PlatformDemoIntentIdempotencyConflictError";
  }
}

function validateIntent(input: {
  provider: PlatformDemoProvider;
  strategyCode: StrategyCode;
  decisionRoundId: string;
  runtimeCycleId?: string | null;
  traceId: string;
  symbol: string;
  side: "buy" | "sell";
  referencePrice: number;
}) {
  if (!(["okx", "binance", "bybit"] as string[]).includes(input.provider)) throw new Error("Demo provider 无效");
  if (!(["ai_conservative", "ai_balanced", "ai_aggressive"] as string[]).includes(input.strategyCode)) throw new Error("Demo 策略卡无效");
  if (!input.decisionRoundId.trim() || input.decisionRoundId.length > 256) throw new Error("Demo 决策轮标识无效");
  if (!input.traceId.trim() || input.traceId.length > 128) throw new Error("Demo traceId 无效");
  if (!(["BTCUSDT", "ETHUSDT", "SOLUSDT"] as string[]).includes(input.symbol)) throw new Error("Demo 现货交易对无效");
  if (input.side !== "buy" && input.side !== "sell") throw new Error("Demo 现货方向无效");
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0) throw new Error("Demo 参考价格无效");
}

function intentView(row: {
  id: string; provider: PlatformDemoProvider; strategy_code: StrategyCode;
  decision_round_id: string; trace_id: string; client_order_id: string;
  symbol: string; side: "buy" | "sell"; quote_amount_usdt: string; status: string;
}) {
  return {
    id: row.id,
    provider: row.provider,
    strategyCode: row.strategy_code,
    decisionRoundId: row.decision_round_id,
    traceId: row.trace_id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    side: row.side,
    quoteAmountUsdt: Number(row.quote_amount_usdt),
    status: row.status,
  };
}

export async function createPlatformDemoIntent(database: Pool, input: {
  provider: PlatformDemoProvider;
  strategyCode: StrategyCode;
  decisionRoundId: string;
  runtimeCycleId?: string | null;
  traceId: string;
  symbol: string;
  side: "buy" | "sell";
  referencePrice: number;
}) {
  validateIntent(input);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const account = (await client.query<{
      id: string; enabled: boolean; kill_switch_enabled: boolean;
    }>(`
      SELECT id, enabled, kill_switch_enabled
      FROM platform_demo_accounts WHERE provider = $1 FOR UPDATE
    `, [input.provider])).rows[0];
    if (!account?.enabled) throw new Error(`${input.provider} Demo 平台账户未启用`);
    if (account.kill_switch_enabled) throw new Error(`${input.provider} Demo provider kill switch 已启用停控`);
    const card = (await client.query<{ kill_switch_enabled: boolean }>(`
      SELECT kill_switch_enabled FROM platform_demo_card_controls
      WHERE provider = $1 AND strategy_code = $2
    `, [input.provider, input.strategyCode])).rows[0];
    if (card?.kill_switch_enabled) throw new Error(`${input.provider}/${input.strategyCode} Demo card kill switch 已启用停控`);
    const clientOrderId = deterministicDemoClientOrderId(input);
    const result = await client.query<{
      id: string; provider: PlatformDemoProvider; strategy_code: StrategyCode;
      decision_round_id: string; trace_id: string; client_order_id: string;
      symbol: string; side: "buy" | "sell"; quote_amount_usdt: string; status: string;
    }>(`
      INSERT INTO platform_demo_order_intents AS existing (
        id, account_id, provider, strategy_code, decision_round_id,
        runtime_cycle_id, trace_id, client_order_id, symbol, side, quote_amount_usdt,
        reference_price
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 10, $11)
      ON CONFLICT (provider, strategy_code, decision_round_id)
      DO UPDATE SET decision_round_id = EXCLUDED.decision_round_id
      WHERE existing.account_id = EXCLUDED.account_id
        AND existing.runtime_cycle_id IS NOT DISTINCT FROM EXCLUDED.runtime_cycle_id
        AND existing.trace_id = EXCLUDED.trace_id
        AND existing.client_order_id = EXCLUDED.client_order_id
        AND existing.symbol = EXCLUDED.symbol
        AND existing.side = EXCLUDED.side
        AND existing.quote_amount_usdt = EXCLUDED.quote_amount_usdt
        AND existing.reference_price = EXCLUDED.reference_price
      RETURNING id, provider, strategy_code, decision_round_id, trace_id,
                client_order_id, symbol, side, quote_amount_usdt, status
    `, [crypto.randomUUID(), account.id, input.provider, input.strategyCode, input.decisionRoundId,
      input.runtimeCycleId ?? null, input.traceId, clientOrderId, input.symbol, input.side, input.referencePrice]);
    if (!result.rows[0]) throw new PlatformDemoIntentIdempotencyConflictError();
    await client.query("COMMIT");
    return intentView(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueuePlatformDemoIntentsForRound(database: Pool, input: {
  strategyCode: StrategyCode;
  decisionRoundId: string;
  runtimeCycleId: string;
  traceId: string;
  symbol: string;
  side: "buy" | "sell";
  referencePrice: number;
}) {
  const accounts = await database.query<{ provider: PlatformDemoProvider }>(`
    SELECT provider FROM platform_demo_accounts
    WHERE enabled = true AND kill_switch_enabled = false
    ORDER BY provider
  `);
  const results = [];
  for (const account of accounts.rows) {
    try {
      const intent = await createPlatformDemoIntent(database, { ...input, provider: account.provider });
      results.push({ provider: account.provider, status: "queued" as const, intentId: intent.id });
    } catch (error) {
      results.push({
        provider: account.provider,
        status: "skipped" as const,
        reason: error instanceof Error ? error.message.slice(0, 160) : "Demo intent enqueue failed",
      });
    }
  }
  return results;
}

export async function leaseNextPlatformDemoIntent(database: Queryable, input: {
  workerId: string;
  now: Date;
  leaseSeconds: number;
}) {
  if (!input.workerId.trim() || input.workerId.length > 120) throw new Error("Demo Worker ID 无效");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300) throw new Error("Demo Worker 租约时长无效");
  const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
  const result = await database.query<{
    id: string; account_id: string; provider: PlatformDemoProvider; strategy_code: StrategyCode;
    decision_round_id: string; trace_id: string; client_order_id: string; symbol: string;
    side: "buy" | "sell"; quote_amount_usdt: string; provider_order_id: string | null;
    reference_price: string;
    fencing_token: string; attempt_count: number; leased_from_status: "pending" | "retry_wait" | "unknown";
    api_key_ciphertext: string; secret_ciphertext: string; passphrase_ciphertext: string | null;
  }>(`
    WITH picked AS (
      SELECT intent.id,
             CASE WHEN intent.status = 'running' THEN 'unknown' ELSE intent.status END AS leased_from_status
      FROM platform_demo_order_intents AS intent
      JOIN platform_demo_accounts AS account ON account.id = intent.account_id
      LEFT JOIN platform_demo_card_controls AS control
        ON control.provider = intent.provider AND control.strategy_code = intent.strategy_code
      WHERE intent.next_attempt_at <= $1
        AND (
          intent.status IN ('pending', 'retry_wait', 'unknown')
          OR (intent.status = 'running' AND intent.lease_expires_at <= $1)
        )
        AND account.enabled = true
        AND account.kill_switch_enabled = false
        AND COALESCE(control.kill_switch_enabled, false) = false
      ORDER BY intent.next_attempt_at, intent.created_at, intent.id
      FOR UPDATE OF intent SKIP LOCKED LIMIT 1
    )
    UPDATE platform_demo_order_intents AS intent
    SET status = 'running', lease_owner = $2, lease_expires_at = $3,
        fencing_token = intent.fencing_token + 1,
        attempt_count = intent.attempt_count + 1,
        updated_at = $1
    FROM picked, platform_demo_accounts AS account
    WHERE intent.id = picked.id AND account.id = intent.account_id
    RETURNING intent.id, intent.account_id, intent.provider, intent.strategy_code,
      intent.decision_round_id, intent.trace_id, intent.client_order_id, intent.symbol,
      intent.side, intent.quote_amount_usdt, intent.reference_price, intent.provider_order_id,
      intent.fencing_token, intent.attempt_count,
      picked.leased_from_status, account.api_key_ciphertext,
      account.secret_ciphertext, account.passphrase_ciphertext
  `, [input.now, input.workerId, expiresAt]);
  const row = result.rows[0];
  return row ? {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    strategyCode: row.strategy_code,
    decisionRoundId: row.decision_round_id,
    traceId: row.trace_id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    side: row.side,
    quoteAmountUsdt: Number(row.quote_amount_usdt),
    referencePrice: Number(row.reference_price),
    providerOrderId: row.provider_order_id,
    fencingToken: Number(row.fencing_token),
    attemptCount: row.attempt_count,
    leasedFromStatus: row.leased_from_status,
    apiKeyCiphertext: row.api_key_ciphertext,
    secretCiphertext: row.secret_ciphertext,
    passphraseCiphertext: row.passphrase_ciphertext,
  } : null;
}

async function assertPlatformDemoLeaseEnabled(database: Queryable, input: {
  accountId: string;
  provider: PlatformDemoProvider;
  strategyCode: StrategyCode;
}) {
  const result = await database.query<{ enabled: boolean }>(`
    SELECT account.enabled = true
       AND account.kill_switch_enabled = false
       AND COALESCE(control.kill_switch_enabled, false) = false AS enabled
    FROM platform_demo_accounts AS account
    LEFT JOIN platform_demo_card_controls AS control
      ON control.provider = $2 AND control.strategy_code = $3
    WHERE account.id = $1 AND account.provider = $2
  `, [input.accountId, input.provider, input.strategyCode]);
  if (result.rows[0]?.enabled !== true) throw new Error("Demo provider/card 已停控，外部调用被阻止");
}

export async function renewPlatformDemoLease(database: Queryable, input: {
  intentId: string;
  workerId: string;
  fencingToken: number;
  now: Date;
  leaseSeconds: number;
}) {
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300) throw new Error("Demo Worker 续租时长无效");
  const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
  const result = await database.query(`
    UPDATE platform_demo_order_intents
    SET lease_expires_at = $5, updated_at = $4
    WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
      AND status = 'running' AND lease_expires_at > $4
  `, [input.intentId, input.workerId, input.fencingToken, input.now, expiresAt]);
  if (result.rowCount !== 1) throw new Error("Demo Worker 续租失败：租约或 fencing token 已失效");
  return { leaseExpiresAt: expiresAt };
}

async function completePlatformDemoIntent(database: Pool, input: {
  intentId: string;
  workerId: string;
  fencingToken: number;
  provider: PlatformDemoProvider;
  providerOrderId: string;
  clientOrderId: string;
  traceId: string;
  status: "accepted" | "partially_filled" | "filled" | "cancelled" | "rejected";
  filledBaseQuantity: number;
  filledQuoteUsdt: number;
  feeUsdt: number;
  observedAt: Date;
}) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(`
      UPDATE platform_demo_order_intents
      SET status = $4, provider_order_id = $5,
          lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = NULL, last_error_message = NULL, updated_at = $6
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND status = 'running'
      RETURNING id
    `, [input.intentId, input.workerId, input.fencingToken,
      input.status === "cancelled" ? "cancelled" : input.status === "rejected" ? "failed" : "accepted",
      input.providerOrderId, input.observedAt]);
    if (!updated.rows[0]) throw new Error("Demo Worker 完成失败：租约或 fencing token 已失效");
    await client.query(`
      INSERT INTO platform_demo_execution_receipts (
        id, intent_id, provider, provider_order_id, client_order_id, status,
        filled_base_quantity, filled_quote_usdt, fee_usdt,
        observed_at, trace_id, safe_summary_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      ON CONFLICT (intent_id, provider_order_id, status, observed_at) DO NOTHING
    `, [crypto.randomUUID(), input.intentId, input.provider, input.providerOrderId,
      input.clientOrderId, input.status, input.filledBaseQuantity, input.filledQuoteUsdt,
      input.feeUsdt, input.observedAt, input.traceId,
      JSON.stringify({ status: input.status, filledBaseQuantity: input.filledBaseQuantity, filledQuoteUsdt: input.filledQuoteUsdt, feeUsdt: input.feeUsdt })]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function failPlatformDemoIntent(database: Queryable, input: {
  intentId: string;
  workerId: string;
  fencingToken: number;
  status: "unknown" | "retry_wait" | "failed";
  code: string;
  message: string;
  retryAt: Date;
}) {
  const result = await database.query(`
    UPDATE platform_demo_order_intents
    SET status = $4, last_error_code = $5, last_error_message = $6,
        next_attempt_at = $7, lease_owner = NULL, lease_expires_at = NULL,
        updated_at = now()
    WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND status = 'running'
  `, [input.intentId, input.workerId, input.fencingToken, input.status,
    input.code, input.message.slice(0, 500), input.retryAt]);
  if (result.rowCount !== 1) throw new Error("Demo Worker 失败回执写入失败：租约或 fencing token 已失效");
}

type WorkerAdapter = Pick<PlatformDemoAdapter, "placeOrder" | "getOrder" | "listFills">;

export type PlatformDemoExecutionDependencies = {
  now?: () => Date;
  externalWritesEnabled?: boolean;
  decryptSecret?: (ciphertext: string) => Promise<string>;
  createAdapter?: (provider: PlatformDemoProvider, credentials: {
    apiKey: string; secret: string; passphrase?: string;
  }) => WorkerAdapter;
  heartbeatIntervalMs?: number;
};

function startDemoLeaseHeartbeat(database: Pool, input: {
  intentId: string;
  workerId: string;
  fencingToken: number;
  leaseSeconds: number;
  intervalMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const intervalMs = input.intervalMs === undefined
    ? Math.max(1_000, Math.floor(input.leaseSeconds * 1_000 / 3))
    : Math.min(Math.max(input.intervalMs, 10), Math.floor(input.leaseSeconds * 1_000 / 2));
  const tick = () => {
    if (stopped) return;
    inFlight = renewPlatformDemoLease(database, {
      intentId: input.intentId,
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      now: new Date(),
      leaseSeconds: input.leaseSeconds,
    }).then(() => undefined).catch(() => undefined).finally(() => {
      inFlight = null;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  timer = setTimeout(tick, intervalMs);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (inFlight) await inFlight;
  };
}

export async function processNextPlatformDemoExecution(
  database: Pool,
  input: { workerId: string; leaseSeconds?: number },
  dependencies: PlatformDemoExecutionDependencies = {},
) {
  const enabled = dependencies.externalWritesEnabled
    ?? process.env.PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED === "true";
  if (!enabled) return { status: "disabled" as const };
  const now = dependencies.now?.() ?? new Date();
  const leaseSeconds = input.leaseSeconds ?? 60;
  const lease = await leaseNextPlatformDemoIntent(database, { workerId: input.workerId, now, leaseSeconds });
  if (!lease) return null;
  const stopHeartbeat = startDemoLeaseHeartbeat(database, {
    intentId: lease.id,
    workerId: input.workerId,
    fencingToken: lease.fencingToken,
    leaseSeconds,
    intervalMs: dependencies.heartbeatIntervalMs,
  });
  try {
    const decrypt = dependencies.decryptSecret ?? decryptIntegrationSecret;
    const [apiKey, secret, passphrase] = await Promise.all([
      decrypt(lease.apiKeyCiphertext),
      decrypt(lease.secretCiphertext),
      lease.passphraseCiphertext ? decrypt(lease.passphraseCiphertext) : Promise.resolve(undefined),
    ]);
    await assertPlatformDemoLeaseEnabled(database, {
      accountId: lease.accountId,
      provider: lease.provider,
      strategyCode: lease.strategyCode,
    });
    const adapter = dependencies.createAdapter?.(lease.provider, { apiKey, secret, ...(passphrase ? { passphrase } : {}) })
      ?? createPlatformDemoAdapter(lease.provider, { apiKey, secret, ...(passphrase ? { passphrase } : {}) }, {
        externalWritesEnabled: true,
        transport: createPlatformDemoFetchTransport(),
      });
    const recoverUnknownOrder = async () => {
      try {
        return await adapter.getOrder({ symbol: lease.symbol, clientOrderId: lease.clientOrderId });
      } catch {
        throw new PlatformDemoResponseError("Demo 下单状态未知且查单失败，禁止重复下单", {
          unknownExecutionState: true,
        });
      }
    };
    let order;
    if (lease.leasedFromStatus === "unknown") {
      order = await recoverUnknownOrder();
    } else {
      try {
        order = await adapter.placeOrder({
          symbol: lease.symbol,
          side: lease.side,
          quoteAmountUsdt: lease.quoteAmountUsdt,
          baseQuantity: lease.side === "sell" ? lease.quoteAmountUsdt / lease.referencePrice : undefined,
          clientOrderId: lease.clientOrderId,
        });
      } catch (error) {
        if (!(error instanceof PlatformDemoResponseError) || !error.unknownExecutionState) throw error;
        order = await recoverUnknownOrder();
      }
    }
    const fills = await adapter.listFills({ symbol: lease.symbol, providerOrderId: order.providerOrderId });
    const filledBaseQuantity = fills.reduce((sum, fill) => sum + fill.baseQuantity, 0);
    const filledQuoteUsdt = fills.reduce((sum, fill) => sum + fill.baseQuantity * fill.price, 0);
    const feeUsdt = fills.reduce((sum, fill) => sum + fill.feeUsdt, 0);
    const status = order.status === "filled" ? "filled"
      : filledBaseQuantity > 0 ? "partially_filled"
        : order.status === "cancelled" ? "cancelled"
          : order.status === "rejected" ? "rejected" : "accepted";
    await completePlatformDemoIntent(database, {
      intentId: lease.id,
      workerId: input.workerId,
      fencingToken: lease.fencingToken,
      provider: lease.provider,
      providerOrderId: order.providerOrderId,
      clientOrderId: lease.clientOrderId,
      traceId: lease.traceId,
      status,
      filledBaseQuantity,
      filledQuoteUsdt,
      feeUsdt,
      observedAt: now,
    });
    return {
      status: "recorded" as const,
      executionStatus: status,
      intentId: lease.id,
      provider: lease.provider,
      providerOrderId: order.providerOrderId,
      clientOrderId: lease.clientOrderId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Demo execution failed";
    const unknown = error instanceof PlatformDemoResponseError && error.unknownExecutionState;
    const terminal = lease.attemptCount >= 5;
    await failPlatformDemoIntent(database, {
      intentId: lease.id,
      workerId: input.workerId,
      fencingToken: lease.fencingToken,
      status: terminal ? "failed" : unknown ? "unknown" : "retry_wait",
      code: unknown ? "DEMO_EXECUTION_STATE_UNKNOWN" : "DEMO_EXECUTION_FAILED",
      message,
      retryAt: new Date(now.getTime() + Math.min(5 * 60_000, 15_000 * 2 ** Math.max(lease.attemptCount - 1, 0))),
    });
    return { status: terminal ? "failed" as const : unknown ? "unknown" as const : "retry_wait" as const, intentId: lease.id, provider: lease.provider, errorCode: unknown ? "DEMO_EXECUTION_STATE_UNKNOWN" : "DEMO_EXECUTION_FAILED" };
  } finally {
    await stopHeartbeat();
  }
}
