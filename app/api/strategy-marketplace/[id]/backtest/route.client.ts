import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  communityStrategies,
  strategyValidations as strategyBacktestReports,
} from "@/db/schema";
import { normalizeBacktestOptions, runBacktestOnCandles, runPerpetualBacktestOnCandles } from "@/packages/domain/src/backtest-engine.ts";
import { loadBacktestCandles } from "@/lib/backtest-engine";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import {
  assessPerpetualDataQuality,
  createPerpetualMarketAdapter,
  type PerpetualExchange,
} from "@/lib/perpetual-market-adapters";
import { getPostgresPool } from "@/lib/postgres";
import { getOwnedResearchRun } from "@/lib/postgres-research-queue";
import { requireUser, responseError } from "@/lib/session";
import { normalizeResearchStrategyDsl } from "@/packages/domain/src/strategy-dsl";

type BacktestStage = "validating" | "market_data" | "funding" | "engine" | "saving";
type BacktestProgress = (event: {
  type: "progress";
  stage: BacktestStage;
  progress: number;
  message: string;
}) => void;

const noProgress: BacktestProgress = () => {};

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
  onProgress: BacktestProgress = noProgress,
) {
  onProgress({ type: "progress", stage: "validating", progress: 8, message: "正在校验策略 DSL 与回测参数" });
  const specification = normalizeResearchStrategyDsl(JSON.parse(strategy.specificationJson || "{}"));
  if (specification.schemaVersion === 1) {
    const options = normalizeBacktestOptions(rawOptions);
    onProgress({ type: "progress", stage: "market_data", progress: 22, message: "正在读取完整历史 K 线" });
    const { candles, provider } = await loadBacktestCandles(specification, options.candleLimit);
    onProgress({ type: "progress", stage: "funding", progress: 55, message: "现货策略无需资金费率，正在核对成本参数" });
    onProgress({ type: "progress", stage: "engine", progress: 68, message: "确定性回测引擎正在逐根处理 K 线" });
    return runBacktestOnCandles(specification, candles, { ...options, provider });
  }

  const options = normalizeBacktestOptions(rawOptions);
  const exchange = await resolveResearchExchange(strategy, ownerUserId);
  const adapter = createPerpetualMarketAdapter(exchange);
  onProgress({ type: "progress", stage: "market_data", progress: 22, message: "正在读取合约规则、历史 K 线和费率" });
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
  onProgress({ type: "progress", stage: "funding", progress: 52, message: "正在加载并校验历史资金费率" });
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
  onProgress({ type: "progress", stage: "engine", progress: 68, message: "确定性回测引擎正在逐根处理 K 线" });
  const result = await runPerpetualBacktestOnCandles(specification, candles.items, funding.items, {
    ...options,
    feeRate: fee.takerRate,
    provider: `${exchange} perpetual historical API`,
  });
  if (fee.estimated) result.warnings.push("账户实际手续费不可读取，本次采用管理员保守费率估算");
  if (!quality.isVerifiable) result.warnings.push("行情或资金费率存在质量缺口，本次结果不能作为标准验证结论");
  return { ...result, dataQuality: quality, feeSchedule: fee };
}

async function persistBacktest(
  db: ReturnType<typeof getDb>,
  strategy: typeof communityStrategies.$inferSelect,
  ownerUserId: string,
  id: string,
  options: Record<string, unknown>,
  onProgress: BacktestProgress = noProgress,
) {
  const result = await runSavedStrategyBacktest(strategy, ownerUserId, options, onProgress);
  onProgress({ type: "progress", stage: "saving", progress: 90, message: "正在保存报告、证据哈希和审计记录" });
  const reportId = crypto.randomUUID();
  const now = new Date().toISOString();

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
      actorUserId: ownerUserId,
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

  return {
    reportId,
    result,
    message: result.warnings.length
      ? `历史回测已完成：${result.warnings.join("；")}`
      : "历史回测已完成，报告已保存",
  };
}

function streamBacktest(run: (onProgress: BacktestProgress) => Promise<Awaited<ReturnType<typeof persistBacktest>>>) {
  const encoder = new TextEncoder();
  let controllerClosed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const emit = (event: Record<string, unknown>) => {
    if (controllerClosed) return;
    try {
      streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      controllerClosed = true;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      void run(event => emit(event)).then(payload => {
        emit({ type: "completed", progress: 100, ...payload });
      }).catch(error => {
        emit({
          type: "failed",
          progress: 100,
          error: { code: "BACKTEST_FAILED", message: error instanceof Error ? error.message : "历史回测失败" },
        });
      }).finally(() => {
        if (!controllerClosed) controller.close();
        controllerClosed = true;
      });
    },
    cancel() {
      // 客户端切换页面只关闭进度订阅，不取消已经开始的服务端回测和报告保存。
      controllerClosed = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
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

    if (new URL(request.url).searchParams.get("stream") === "1") {
      return streamBacktest(onProgress => persistBacktest(db, strategy, me.id, id, options, onProgress));
    }

    const payload = await persistBacktest(db, strategy, me.id, id, options);
    return Response.json(payload, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
