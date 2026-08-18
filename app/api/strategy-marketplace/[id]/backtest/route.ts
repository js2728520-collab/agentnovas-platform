import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  communityStrategies,
  strategyValidations as strategyBacktestReports,
} from "@/db/schema";
import {
  normalizeBacktestOptions,
  runHistoricalBacktest,
  runPerpetualBacktestOnCandles,
} from "@/lib/backtest-engine";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import {
  assessPerpetualDataQuality,
  createPerpetualMarketAdapter,
  type PerpetualExchange,
} from "@/lib/perpetual-market-adapters";
import { getPostgresPool } from "@/lib/postgres";
import { getOwnedResearchRun } from "@/lib/postgres-research-queue";
import { requireUser, responseError } from "@/lib/session";
import { normalizeResearchStrategyDsl } from "@/lib/strategy-dsl";

async function resolveResearchExchange(strategy: typeof communityStrategies.$inferSelect, ownerUserId: string) {
  if (!strategy.researchRunId) return "binance" as const;
  const pool = await getPostgresPool();
  const run = await getOwnedResearchRun(pool, { runId: strategy.researchRunId, ownerUserId });
  if (!run) throw new Error("策略关联的研发任务不存在或无权访问");
  const exchange = String(run.brief.exchange ?? "").toLowerCase();
  if (!(["okx", "binance", "bybit"] as const).includes(exchange as PerpetualExchange)) {
    throw new Error("策略关联的永续交易所无效");
  }
  return exchange as PerpetualExchange;
}

async function runSavedStrategyBacktest(
  strategy: typeof communityStrategies.$inferSelect,
  ownerUserId: string,
  rawOptions: Record<string, unknown>,
) {
  const specification = normalizeResearchStrategyDsl(JSON.parse(strategy.specificationJson || "{}"));
  if (specification.schemaVersion === 1) return runHistoricalBacktest(specification, rawOptions);

  const options = normalizeBacktestOptions(rawOptions);
  const exchange = await resolveResearchExchange(strategy, ownerUserId);
  const adapter = createPerpetualMarketAdapter(exchange);
  const [instrument, candles, fee] = await Promise.all([
    adapter.getInstrument({ symbol: specification.symbol }),
    adapter.getCandles({
      symbol: specification.symbol,
      timeframe: specification.timeframe,
      limit: options.candleLimit,
    }),
    adapter.getFeeSchedule({ symbol: specification.symbol }),
  ]);
  if (instrument.status !== "live") throw new Error("永续合约当前不可用");
  if (candles.items.length < 200) throw new Error("完整永续 K 线样本不足 200 根");
  const startTime = candles.items[0].openTime;
  const endTime = candles.items.at(-1)!.closeTime;
  const fundingLimit = Math.min(
    Math.ceil((endTime - startTime) / (instrument.fundingIntervalHours * 3_600_000)) + 10,
    10_000,
  );
  const funding = await adapter.getFundingRates({
    symbol: specification.symbol,
    startTime,
    endTime,
    limit: Math.max(fundingLimit, 1),
  });
  const quality = assessPerpetualDataQuality({
    candles,
    funding,
    timeframe: specification.timeframe,
    expectedFundingIntervalHours: instrument.fundingIntervalHours,
    feeEstimated: fee.estimated,
  });
  const result = await runPerpetualBacktestOnCandles(specification, candles.items, funding.items, {
    ...options,
    feeRate: fee.takerRate,
    provider: `${exchange} perpetual historical API`,
  });
  if (fee.estimated) result.warnings.push("账户实际手续费不可读取，本次采用管理员保守费率估算");
  if (!quality.isVerifiable) result.warnings.push("行情或资金费率存在质量缺口，本次结果不能作为标准验证结论");
  return { ...result, dataQuality: quality, feeSchedule: fee };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureDatabaseSchema();
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const db = getDb();
    const strategy = (await db
      .select()
      .from(communityStrategies)
      .where(and(
        eq(communityStrategies.id, id),
        eq(communityStrategies.authorUserId, me.id),
      ))
      .limit(1))[0];

    if (!strategy || !["draft", "testing", "rejected"].includes(strategy.status)) {
      return Response.json({ error: "策略不存在或当前状态不可回测" }, { status: 409 });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    let options;
    try {
      options = normalizeBacktestOptions(body);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "回测参数无效" }, { status: 400 });
    }

    const result = await runSavedStrategyBacktest(strategy, me.id, options);
    const reportId = crypto.randomUUID();
    const now = new Date().toISOString();

    // 复用已有历史数据表保存回测报告，但报告不构成提交或审核门槛。
    await db.batch([
      db.insert(strategyBacktestReports).values({
        id: reportId,
        strategyId: id,
        strategyVersion: strategy.version,
        kind: "backtest",
        status: "passed",
        source: "platform_engine",
        periodStart: result.periodStart,
        periodEnd: result.periodEnd,
        sampleSize: result.sampleSize,
        netReturnPct: result.netReturnPct,
        maxDrawdownPct: result.maxDrawdownPct,
        winRatePct: result.winRatePct,
        evidenceRef: result.evidenceRef,
        metricsJson: JSON.stringify(result),
        completedAt: now,
      }),
      db.update(communityStrategies)
        .set({ status: "testing", updatedAt: now })
        .where(eq(communityStrategies.id, id)),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: "strategy.backtest.completed",
        subjectType: "community_strategy",
        subjectId: id,
        afterJson: JSON.stringify({
          reportId,
          source: "platform_engine",
          evidenceRef: result.evidenceRef,
          warnings: result.warnings,
          parameters: result.parameters,
        }),
      }),
    ]);

    return Response.json({
      reportId,
      result,
      message: result.warnings.length
        ? `历史回测已完成：${result.warnings.join("；")}`
        : "历史回测已完成，报告已保存",
    }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
