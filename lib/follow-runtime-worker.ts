import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { evaluateFollowSpotAdmission } from "../packages/domain/src/follow-spot-admission.ts";
import { evaluateFollowRisk } from "../packages/domain/src/strategy-follow-risk.ts";
import { followAllowsNewEntry, isFollowLifecycleState } from "../packages/domain/src/strategy-follow-lifecycle.ts";
import { completedRuntimeCandlesAt } from "../packages/domain/src/runtime/market-admission.ts";
import { evaluateStrategyRuntimeCycle } from "../packages/domain/src/strategy-runtime-engine.ts";
import { neutralRuntimeRiskState } from "../packages/domain/src/runtime/risk-state.ts";
import { completeFollowRuntimeCycle, settlePendingFollowPaperOrder } from "./follow-paper-repository.ts";
import { leaseNextFollowDeployment, renewStrategyRuntimeLease } from "./strategy-runtime-repository.ts";

type FollowLease = NonNullable<Awaited<ReturnType<typeof leaseNextFollowDeployment>>>;

export type FollowRuntimeDependencies = {
  now?: () => Date;
  getCandles?: (input: { symbol: string; timeframe: string; limit: number }) => Promise<{
    items: Array<{ openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number }>;
    provider: string;
  }>;
};

/**
 * 社区策略跟单的现货模拟运行周期（T4.4 第 1 步）。
 *
 * 与官方卡那条路径**共用引擎与记账**，不共用编排：官方卡要处理会员权益、共享决策轮、
 * Demo 意图与实盘下发，跟单这条都没有；反过来跟单要读跟单合同与生命周期，官方卡没有。
 * 硬合成一个函数会让两套前置条件互相渗透，而它们的失败关闭方向不一样。
 *
 * 不产生共享决策轮：ADR-0018 的共享轮只属于三张官方卡
 * （`strategy_decision_rounds.strategy_code` 的 CHECK 就是这么定的）。
 */
export async function processFollowSpotRuntimeDeployment(
  database: Pool,
  lease: FollowLease,
  dependencies: FollowRuntimeDependencies = {},
): Promise<{ status: string; reason?: string; cycleId?: string; duplicate?: boolean; decision?: unknown }> {
  const now = dependencies.now?.() ?? new Date();

  // 现货准入。双向与做空策略在现货上跑不了，杠杆策略跑起来也不是作者写的那个策略。
  const admission = evaluateFollowSpotAdmission(lease.specification);
  if (!admission.admitted) {
    return { status: "not_admitted", reason: admission.reason };
  }
  // 跟单合同缺失时不跑。合同是客户同意过的风险参数，缺了就没有依据可循——猜一组数字
  // 去跑等于替客户决定他同意了什么。
  if (!lease.contractId || !lease.risk) {
    return { status: "blocked", reason: "missing_follow_contract" };
  }

  const getCandles = dependencies.getCandles;
  if (!getCandles) {
    // 行情适配器由调用方注入。没有注入就不跑——**不回落到某个默认源**：默认源意味着
    // 客户的模拟盘依据一个他没选过、也没记录在案的数据来源（ADR-0025 同一条原则）。
    return { status: "blocked", reason: "missing_market_adapter" };
  }
  const market = await getCandles({ symbol: admission.symbol, timeframe: admission.timeframe, limit: 500 });
  const completed = completedRuntimeCandlesAt(market.items, now.getTime());
  if (completed.length < 2) return { status: "waiting_for_candle" };

  const selected = completed.at(-1)!;
  const lastClose = lease.lastCandleCloseAt?.getTime() ?? null;
  if (lastClose !== null && selected.closeTime <= lastClose) return { status: "waiting_for_candle" };

  // 先把上一轮已确定的成交落账，再读仓位。顺序不能反——账本落后一轮，引擎读到的就是
  // 「还没建仓」，于是这一轮会再开一次。
  await settlePendingFollowPaperOrder(database, {
    deploymentId: lease.id,
    fillPrice: selected.open,
    fillTime: new Date(selected.openTime),
    timing: "next_candle_open",
    traceId: `follow-settle:${lease.id}:${selected.openTime}`,
  });

  const position = await loadOpenPosition(database, lease.portfolioId, admission.symbol);
  const stopLossPct = Number((lease.risk as { stopLossPct?: unknown }).stopLossPct ?? 0);
  const drawdownPct = await loadDrawdownPct(database, lease.portfolioId);

  // 自动风控（T4.4b 的判定函数在这里有了调用点）。
  const listing = await loadListingState(database, lease.strategyId);
  const risk = evaluateFollowRisk({
    drawdownPct,
    stopLossPct,
    listingStatus: listing.status,
    delistReason: listing.delistReason,
  });

  // 风控触发时把订阅置成 risk_blocked 并留下事件。
  //
  // 只挡开仓不写回状态，客户与运营在界面上完全看不出这个跟随已经被风控停了——他们看到
  // 的仍是「运行中，只是一直不开仓」。四方停止的意义正是让「谁停的」可查（PRD 6.6）。
  if (risk.blocked && lease.subscriptionStatus === "active") {
    await blockFollowByAutomatedRisk(database, lease.subscriptionId, risk);
  }

  // 生命周期与风控共同决定能否新开仓；离场始终允许（INV-7）。
  const lifecycleAllows = isFollowLifecycleState(lease.subscriptionStatus)
    && followAllowsNewEntry(lease.subscriptionStatus);
  const allowsNewEntry = lifecycleAllows && !risk.blocked;

  const evaluated = evaluateStrategyRuntimeCycle({
    deploymentId: lease.id,
    strategyVersionId: lease.strategyVersionId,
    dsl: lease.specification,
    candles: completed,
    mode: lease.mode,
    position: position
      ? { side: "long" as const, entryPrice: position.entryPrice, quantity: position.quantity }
      : null,
    lastDecisionCandleCloseTime: lastClose,
    marketData: {
      evaluatedAt: now.getTime(),
      latestClosedAt: selected.closeTime,
      timeframe: admission.timeframe,
    },
    // 跟单的模拟盘没有独立的风控读数来源；用中性状态，真正的阻断走 followLifecycle。
    riskState: neutralRuntimeRiskState(),
    followLifecycle: { allowsNewEntry },
  });

  // 单笔名义金额 = 本金 × 客户同意的每单占比。本金取组合自己的值，不写死。
  const portfolio = await loadPortfolio(database, lease.portfolioId);
  const capitalPct = Number((lease.risk as { capitalPct?: unknown }).capitalPct ?? 0);
  const quoteAmountUsdt = portfolio.principalUsdt * capitalPct / 100;

  const completion = await completeFollowRuntimeCycle(database, {
    cycleId: `follow:${lease.id}:${selected.closeTime}`,
    deploymentId: lease.id,
    portfolioId: lease.portfolioId,
    fencingToken: lease.fencingToken,
    candleOpenTime: new Date(selected.openTime),
    candleCloseTime: new Date(selected.closeTime),
    decision: evaluated.decision as Record<string, unknown>,
    orderIntent: (evaluated.orderIntent ?? null) as Record<string, unknown> | null,
    events: evaluated.events,
    traceId: crypto.randomUUID(),
    startedAt: now,
    // 下一轮在下一根 K 线收盘之后。
    nextCycleAt: new Date(selected.closeTime + timeframeMs(admission.timeframe)),
    symbol: admission.symbol,
    shadow: lease.mode === "shadow",
    quoteAmountUsdt,
    feeRate: 0.001,
  });

  return {
    status: "completed",
    cycleId: completion.id,
    duplicate: completion.duplicate,
    decision: evaluated.decision,
    reason: risk.blocked ? risk.triggeredRules.join(",") : undefined,
  };
}

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

function timeframeMs(timeframe: string): number {
  const value = TIMEFRAME_MS[timeframe];
  // 未知周期回落到 1 小时而不是 0：0 会让下一轮立刻可租，把 Worker 变成忙等。
  return value ?? 3_600_000;
}

async function loadPortfolio(database: Pool, portfolioId: string) {
  const result = await database.query<{ principal_usdt: string }>(
    "SELECT principal_usdt FROM strategy_follow_paper_portfolios WHERE id = $1", [portfolioId]);
  return { principalUsdt: Number(result.rows[0]?.principal_usdt ?? 0) };
}

/**
 * Worker 主循环：租一个跟单部署并跑完它的周期。
 *
 * 与官方卡的主循环分开，两者各自租各自的部署——租约的挑选 CTE 互相排斥（一条筛
 * `platform_strategy_code IS NOT NULL`，一条筛 IS NULL），因此不会互相饿死。
 */
export async function processNextFollowRuntimeDeployment(
  database: Pool,
  input: { workerId: string; leaseSeconds?: number },
  dependencies: FollowRuntimeDependencies = {},
) {
  const now = dependencies.now?.() ?? new Date();
  const leaseSeconds = input.leaseSeconds ?? 60;
  const lease = await leaseNextFollowDeployment(database, { workerId: input.workerId, now, leaseSeconds });
  if (!lease) return null;
  try {
    return await processFollowSpotRuntimeDeployment(database, lease, dependencies);
  } catch (error) {
    // 失败也要把租约放开并推后下一轮，否则这个部署会占着租约直到过期，而每次过期后
    // 又立刻被同一个坏状态卡住。
    await renewStrategyRuntimeLease(database, {
      deploymentId: lease.id, workerId: input.workerId,
      fencingToken: lease.fencingToken, now: new Date(), leaseSeconds,
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * 自动风控阻断一个跟随。
 *
 * 只对 `active` 的订阅动手，且状态写回与事件在同一个事务里——写了状态没写事件，事后就说
 * 不出为什么被停；写了事件没写状态，客户下一轮照样开仓。
 *
 * 幂等：已经是 risk_blocked 的不重复写，否则每一轮都会追加一条同样的事件。
 */
async function blockFollowByAutomatedRisk(
  database: Pool,
  subscriptionId: string,
  risk: { triggeredRules: string[]; evidence: Record<string, unknown> },
): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query<{ status: string }>(
      "SELECT status FROM strategy_subscriptions WHERE id=$1 FOR UPDATE", [subscriptionId],
    )).rows[0];
    if (!current || current.status !== "active") {
      await client.query("COMMIT");
      return;
    }
    const reason = `自动风控：${risk.triggeredRules.join("、")}`;
    await client.query(`
      UPDATE strategy_subscriptions
         SET status='risk_blocked', paused_by='automated_risk', paused_at=now(),
             paused_reason=$2, updated_at=now()
       WHERE id=$1
    `, [subscriptionId, reason.slice(0, 300)]);
    await client.query(`
      INSERT INTO strategy_follow_risk_events(
        id, subscription_id, authority, action, reason, triggered_rules_json, evidence_json
      ) VALUES ($1,$2,'automated_risk','pause',$3,$4::jsonb,$5::jsonb)
    `, [randomUUID(), subscriptionId, reason.slice(0, 300),
      JSON.stringify(risk.triggeredRules), JSON.stringify(risk.evidence)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadOpenPosition(database: Pool, portfolioId: string, symbol: string) {
  const result = await database.query<{ quantity: string; average_entry_price: string }>(`
    SELECT quantity, average_entry_price FROM strategy_follow_paper_positions
     WHERE portfolio_id = $1 AND symbol = $2 AND status = 'open'
  `, [portfolioId, symbol]);
  const row = result.rows[0];
  return row ? { quantity: Number(row.quantity), entryPrice: Number(row.average_entry_price) } : null;
}

/** 相对本金的已实现回撤。模拟盘没有逐笔盯市，用已实现净盈亏对本金的比例。 */
async function loadDrawdownPct(database: Pool, portfolioId: string): Promise<number> {
  const result = await database.query<{ principal_usdt: string; realized_net_pnl_usdt: string }>(
    "SELECT principal_usdt, realized_net_pnl_usdt FROM strategy_follow_paper_portfolios WHERE id = $1",
    [portfolioId],
  );
  const row = result.rows[0];
  if (!row) return Number.NaN;
  const principal = Number(row.principal_usdt);
  const pnl = Number(row.realized_net_pnl_usdt);
  if (!Number.isFinite(principal) || principal <= 0) return Number.NaN;
  // 盈利时回撤为 0，不是负数——负回撤会让 `drawdownPct >= stopLossPct` 的比较失去意义。
  return pnl >= 0 ? 0 : Math.abs(pnl) / principal * 100;
}

async function loadListingState(database: Pool, strategyId: string) {
  const result = await database.query<{ status: string; delist_reason: string | null }>(
    "SELECT status, delist_reason FROM community_strategies WHERE id = $1",
    [strategyId],
  );
  const row = result.rows[0];
  return { status: row?.status ?? "unknown", delistReason: row?.delist_reason ?? null };
}
