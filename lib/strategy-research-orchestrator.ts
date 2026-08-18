import type { Pool } from "pg";

import { resolveAgentRoleConfig, missingAgentRoles, type AgentRole } from "./agent-model-profiles.ts";
import { runPerpetualBacktestOnCandles, type BacktestResult, type HistoricalFundingRate } from "./backtest-engine.ts";
import { cachePerpetualMarketData, loadCachedPerpetualMarketData } from "./postgres-market-cache.ts";
import {
  advanceResearchRun,
  pauseResearchRunForMissingRoles,
  renewResearchRunLease,
} from "./postgres-research-queue.ts";
import {
  assessPerpetualDataQuality,
  createPerpetualMarketAdapter,
  type PerpetualExchange,
} from "./perpetual-market-adapters.ts";
import { callStructuredResearchAgent } from "./research-agent.ts";
import {
  completeResearchRun,
  loadInternalCandidates,
  markResearchRunError,
  patchResearchRunResult,
  saveResearchEvaluation,
  setCandidateRanks,
  updateCandidateValidation,
  upsertResearchCandidate,
} from "./research-repository.ts";
import {
  createHoldoutGuard,
  evaluateCandidateAdmission,
  rankResearchCandidates,
  researchModeConfiguration,
  splitResearchCandles,
  type AdmissionMetrics,
  type ResearchMode,
} from "./research-validation.ts";
import { normalizeStrategyDslV2, type StrategyCandle, type StrategyDslV2 } from "./strategy-dsl.ts";

type ResearchLease = {
  id: string;
  ownerUserId: string;
  conversationId: string;
  exchangeAccountId: string;
  mode: ResearchMode;
  stage: string;
  status: string;
  brief: Record<string, unknown>;
  result: Record<string, unknown> | null;
  candidateBudget: number;
  backtestBudget: number;
  backtestsUsed: number;
  attempts: number;
};

function text(value: unknown, fallback: string) {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function marketKey(run: ResearchLease) {
  const exchange = text(run.brief.exchange, "binance").toLowerCase();
  if (!["okx", "binance", "bybit"].includes(exchange)) throw new Error("不支持的永续交易所");
  return {
    exchange: exchange as PerpetualExchange,
    symbol: text(run.brief.symbol, "BTCUSDT").replace(/[^a-z0-9]/gi, "").toUpperCase(),
    timeframe: text(run.brief.timeframe, "1h").toLowerCase(),
  };
}

function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.replace(/sk-[a-z0-9_-]+/gi, "[REDACTED]").slice(0, 500);
}

function deterministicBaseline(run: ResearchLease): StrategyDslV2 {
  const key = marketKey(run);
  const maxDrawdownPct = Math.min(Math.max(Number(run.brief.maxDrawdownPct) || 12, 2), 50);
  return normalizeStrategyDslV2({
    schemaVersion: 2,
    name: `${key.symbol} EMA 确定性基准`,
    market: "usdt_perpetual",
    marginMode: "isolated",
    leverage: 1,
    symbol: key.symbol,
    timeframe: key.timeframe,
    direction: "long_only",
    legs: {
      long: {
        entry: { all: [
          { type: "ema_cross", fastPeriod: 20, slowPeriod: 50, direction: "bullish" },
          { type: "adx_threshold", period: 14, operator: "gte", value: 20 },
        ] },
        exit: { any: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 50, direction: "bearish" }] },
        stopLossPct: Math.min(3, maxDrawdownPct / 2),
        takeProfitPct: 6,
      },
    },
    risk: {
      positionSizePct: Math.min(Math.max(Number(run.brief.positionSizePct) || 10, 1), 30),
      maxDrawdownPct,
      maxDailyLossPct: Math.min(Math.max(Number(run.brief.maxDailyLossPct) || 5, 0.5), 20),
      maxConsecutiveLosses: Math.min(Math.max(Math.round(Number(run.brief.maxConsecutiveLosses) || 4), 1), 10),
    },
  });
}

function parameterVariants(dsl: StrategyDslV2, mode: ResearchMode) {
  const factors = mode === "deep" ? [[1, 1], [0.9, 1.1], [1.1, 0.9]] : [[1, 1], [0.9, 1.1]];
  return factors.map(([stopFactor, takeFactor]) => {
    const candidate = structuredClone(dsl);
    for (const leg of [candidate.legs.long, candidate.legs.short]) {
      if (!leg) continue;
      leg.stopLossPct = Number((leg.stopLossPct * stopFactor).toFixed(4));
      leg.takeProfitPct = Number((leg.takeProfitPct * takeFactor).toFixed(4));
    }
    return normalizeStrategyDslV2(candidate);
  });
}

function fundingWithin(funding: HistoricalFundingRate[], candles: StrategyCandle[]) {
  if (!candles.length) return [];
  return funding.filter(item => item.time >= candles[0].openTime && item.time <= candles.at(-1)!.closeTime);
}

function metrics(result: BacktestResult): AdmissionMetrics {
  return {
    netReturnPct: result.netReturnPct,
    maxDrawdownPct: result.maxDrawdownPct,
    profitFactor: result.profitFactor,
    sampleSize: result.sampleSize,
    liquidated: result.liquidated,
    riskBoundaryBreached: result.warnings.some(item => /单日亏损|连续亏损/.test(item)),
  };
}

function persistedMetrics(result: BacktestResult) {
  const summary = { ...result } as Partial<BacktestResult>;
  delete summary.trades;
  delete summary.parameters;
  return summary as unknown as Record<string, unknown>;
}

function windowChunks<T>(items: T[], count: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(items.length * index / count);
    const end = Math.floor(items.length * (index + 1) / count);
    chunks.push(items.slice(start, end));
  }
  return chunks;
}

async function agentCall(database: Pool, role: AgentRole, context: Record<string, unknown>) {
  const config = await resolveAgentRoleConfig(database, role);
  if (!config) throw new Error(`Agent 角色 ${role} 尚未配置`);
  return callStructuredResearchAgent({ config, role, context });
}

async function persistAndAdvance(database: Pool, run: ResearchLease, workerId: string, input: {
  patch: Record<string, unknown>;
  modelCalls?: number;
  backtests?: number;
  role: string;
  title: string;
  content: Record<string, unknown>;
}) {
  await patchResearchRunResult(database, {
    runId: run.id,
    workerId,
    patch: input.patch,
    modelCalls: input.modelCalls,
    backtests: input.backtests,
  });
  return advanceResearchRun(database, {
    runId: run.id,
    workerId,
    completedStage: run.stage,
    now: new Date(),
    event: { role: input.role, type: "conclusion", title: input.title, content: input.content },
  });
}

async function evaluateCandidates(database: Pool, run: ResearchLease, workerId: string) {
  const key = marketKey(run);
  const artifact = run.result?.dataLoading as Record<string, unknown> | undefined;
  if (!artifact) throw new Error("行情加载结果不存在");
  const startTime = Number(artifact.startTime);
  const endTime = Number(artifact.endTime);
  const loaded = await loadCachedPerpetualMarketData(database, { ...key, startTime, endTime });
  const split = splitResearchCandles(run.mode, loaded.candles);
  const candidates = (await loadInternalCandidates(database, run.id)).filter(item => item.status !== "rejected");
  const quality = artifact.dataQuality as { isVerifiable: boolean };
  const feeRate = Number((artifact.fee as Record<string, unknown>)?.takerRate) || 0.0007;
  const slippageRate = Math.min(Math.max(Number(run.brief.slippageRate) || 0.0005, 0), 0.02);
  const holdoutGuard = createHoldoutGuard();
  let used = 0;

  async function backtest(dsl: StrategyDslV2, candles: StrategyCandle[], costMultiplier = 1) {
    used += 1;
    if (run.backtestsUsed + used > run.backtestBudget) throw new Error("回测预算已耗尽");
    return runPerpetualBacktestOnCandles(dsl, candles, fundingWithin(loaded.fundingRates, candles), {
      provider: `${key.exchange} perpetual historical API`,
      preset: "live_aligned",
      feeRate: Math.min(feeRate * costMultiplier, 0.01),
      slippageRate: Math.min(slippageRate * costMultiplier, 0.02),
      initialEquityUsdt: 10_000,
      candleLimit: Math.min(Math.max(candles.length, 200), 1_000),
    });
  }

  for (const candidate of candidates) {
    await renewResearchRunLease(database, { runId: run.id, workerId, now: new Date(), leaseSeconds: 300 });
    const variants = parameterVariants(normalizeStrategyDslV2(candidate.dsl), run.mode);
    const compared: Array<{ dsl: StrategyDslV2; training: BacktestResult; validation: BacktestResult; score: number }> = [];
    for (let index = 0; index < variants.length; index += 1) {
      const training = await backtest(variants[index], split.training);
      const validation = await backtest(variants[index], split.validation);
      const score = validation.netReturnPct * 2 - validation.maxDrawdownPct + Math.min(validation.profitFactor, 3) * 5;
      compared.push({ dsl: variants[index], training, validation, score });
      await saveResearchEvaluation(database, {
        runId: run.id, candidateId: candidate.id, kind: "training_variant", windowIndex: index,
        periodStart: new Date(split.training[0].openTime), periodEnd: new Date(split.training.at(-1)!.closeTime),
        metrics: persistedMetrics(training), dataQuality: quality as unknown as Record<string, unknown>, passed: training.netReturnPct > 0,
      });
      await saveResearchEvaluation(database, {
        runId: run.id, candidateId: candidate.id, kind: "validation_variant", windowIndex: index,
        periodStart: new Date(split.validation[0].openTime), periodEnd: new Date(split.validation.at(-1)!.closeTime),
        metrics: persistedMetrics(validation), dataQuality: quality as unknown as Record<string, unknown>, passed: validation.netReturnPct > 0,
      });
    }
    const best = compared.sort((left, right) => right.score - left.score)[0];
    let holdoutResult = best.validation;
    let stressResult = best.validation;
    let walks = [best.validation];
    if (run.mode !== "quick") {
      walks = [];
      const chunks = windowChunks(split.validation, researchModeConfiguration[run.mode].walkForwardWindows);
      for (let index = 0; index < chunks.length; index += 1) {
        const result = await backtest(best.dsl, chunks[index]);
        walks.push(result);
        await saveResearchEvaluation(database, {
          runId: run.id, candidateId: candidate.id, kind: "walk_forward", windowIndex: index,
          periodStart: new Date(chunks[index][0].openTime), periodEnd: new Date(chunks[index].at(-1)!.closeTime),
          metrics: persistedMetrics(result), dataQuality: quality as unknown as Record<string, unknown>, passed: result.netReturnPct > 0,
        });
      }
      const finalCandles = holdoutGuard.claim(candidate.id, split.holdout);
      holdoutResult = await backtest(best.dsl, finalCandles);
      stressResult = await backtest(best.dsl, finalCandles, 2);
      await saveResearchEvaluation(database, {
        runId: run.id, candidateId: candidate.id, kind: "final_holdout", windowIndex: 0,
        periodStart: new Date(finalCandles[0].openTime), periodEnd: new Date(finalCandles.at(-1)!.closeTime),
        metrics: persistedMetrics(holdoutResult), dataQuality: quality as unknown as Record<string, unknown>,
        passed: holdoutResult.netReturnPct > 0, finalHoldout: true,
      });
      await saveResearchEvaluation(database, {
        runId: run.id, candidateId: candidate.id, kind: "double_cost_stress", windowIndex: 0,
        periodStart: new Date(finalCandles[0].openTime), periodEnd: new Date(finalCandles.at(-1)!.closeTime),
        metrics: persistedMetrics(stressResult), dataQuality: quality as unknown as Record<string, unknown>,
        passed: stressResult.maxDrawdownPct <= best.dsl.risk.maxDrawdownPct,
      });
    }
    const admission = evaluateCandidateAdmission({
      mode: run.mode,
      holdout: metrics(holdoutResult),
      walkForward: walks.map(metrics),
      stress: metrics(stressResult),
      maxDrawdownPct: best.dsl.risk.maxDrawdownPct,
      dataQuality: quality,
    });
    await updateCandidateValidation(database, {
      candidateId: candidate.id,
      status: admission.qualified ? "qualified" : "rejected",
      score: admission.score,
      validationLabel: admission.validationLabel,
      reasons: admission.reasons,
      dsl: best.dsl,
    });
  }
  return { used };
}

export async function processResearchStage(database: Pool, run: ResearchLease, workerId: string) {
  const missing = await missingAgentRoles(database);
  if (missing.length) {
    await pauseResearchRunForMissingRoles(database, { runId: run.id, missingRoles: missing });
    return;
  }
  try {
    if (run.stage === "requirements") {
      const response = await agentCall(database, "requirements", { requestedBrief: run.brief });
      await persistAndAdvance(database, run, workerId, {
        patch: { requirements: response.output }, modelCalls: 1, role: "requirements",
        title: "需求已结构化", content: { modelName: response.modelName, conclusion: response.output.conclusion, missingFields: response.output.missingFields },
      });
      return;
    }
    if (run.stage === "data_loading") {
      const key = marketKey(run);
      const configuration = researchModeConfiguration[run.mode];
      const requested = Math.min(Math.max(Number(run.brief.candleCount) || configuration.minimumCandles, configuration.minimumCandles), 30_000);
      const adapter = createPerpetualMarketAdapter(key.exchange);
      const [instrument, candles, fee] = await Promise.all([
        adapter.getInstrument({ symbol: key.symbol }),
        adapter.getCandles({ symbol: key.symbol, timeframe: key.timeframe, limit: requested }),
        adapter.getFeeSchedule({ symbol: key.symbol }),
      ]);
      if (instrument.status !== "live") throw new Error("永续合约当前不可用");
      if (candles.items.length < configuration.minimumCandles) throw new Error("交易所返回的完整 K 线样本不足");
      const startTime = candles.items[0].openTime;
      const endTime = candles.items.at(-1)!.closeTime;
      const fundingLimit = Math.min(Math.ceil((endTime - startTime) / (instrument.fundingIntervalHours * 3_600_000)) + 10, 10_000);
      const funding = await adapter.getFundingRates({ symbol: key.symbol, startTime, endTime, limit: fundingLimit });
      const dataQuality = assessPerpetualDataQuality({
        candles, funding, timeframe: key.timeframe,
        expectedFundingIntervalHours: instrument.fundingIntervalHours, feeEstimated: fee.estimated,
      });
      await cachePerpetualMarketData(database, { ...key, candles: candles.items, fundingRates: funding.items });
      const dataLoading = {
        ...key, startTime, endTime, candleCount: candles.items.length, fundingRateCount: funding.items.length,
        priceChangePct: Number(((candles.items.at(-1)!.close / candles.items[0].open - 1) * 100).toFixed(4)),
        instrument, fee, dataQuality,
      };
      await persistAndAdvance(database, run, workerId, {
        patch: { dataLoading }, role: "data_adapter", title: "真实历史行情已加载",
        content: { exchange: key.exchange, symbol: key.symbol, timeframe: key.timeframe, candleCount: candles.items.length, dataQuality },
      });
      return;
    }
    if (run.stage === "regime_analysis") {
      const response = await agentCall(database, "market_regime", { brief: run.brief, marketData: run.result?.dataLoading });
      await persistAndAdvance(database, run, workerId, {
        patch: { marketRegime: response.output }, modelCalls: 1, role: "market_regime",
        title: "市场状态分段完成", content: { modelName: response.modelName, conclusion: response.output.conclusion, regimes: response.output.regimes },
      });
      return;
    }
    if (run.stage === "proposing") {
      const total = run.candidateBudget - 1;
      const context = { brief: run.brief, requirements: run.result?.requirements, marketRegime: run.result?.marketRegime, maximumCandidates: Math.ceil(total / 2) };
      const [proposalA, proposalB] = await Promise.all([
        agentCall(database, "proposal_a", context),
        agentCall(database, "proposal_b", { ...context, maximumCandidates: Math.floor(total / 2) }),
      ]);
      const proposals = [
        ...(proposalA.output.candidates as Array<{ strategyFamily: string; dsl: StrategyDslV2 }>).slice(0, Math.ceil(total / 2)).map(item => ({ ...item, role: "proposal_a" })),
        ...(proposalB.output.candidates as Array<{ strategyFamily: string; dsl: StrategyDslV2 }>).slice(0, Math.floor(total / 2)).map(item => ({ ...item, role: "proposal_b" })),
      ];
      let index = 0;
      for (const proposal of proposals) {
        index += 1;
        await upsertResearchCandidate(database, { runId: run.id, key: `agent-${index}`, strategyFamily: proposal.strategyFamily, sourceRole: proposal.role, dsl: proposal.dsl });
      }
      await upsertResearchCandidate(database, { runId: run.id, key: "deterministic-baseline", strategyFamily: "EMA 趋势基准", sourceRole: "deterministic_baseline", dsl: deterministicBaseline(run) });
      await persistAndAdvance(database, run, workerId, {
        patch: { proposals: { proposalA: proposalA.output.conclusion, proposalB: proposalB.output.conclusion, candidateCount: proposals.length + 1 } },
        modelCalls: 2, role: "proposal_team", title: "独立候选策略已生成",
        content: { models: [proposalA.modelName, proposalB.modelName], candidateCount: proposals.length + 1, includesDeterministicBaseline: true },
      });
      return;
    }
    if (run.stage === "validating") {
      const candidates = await loadInternalCandidates(database, run.id);
      let valid = 0;
      for (const candidate of candidates) {
        try {
          normalizeStrategyDslV2(candidate.dsl);
          valid += 1;
        } catch (error) {
          await updateCandidateValidation(database, { candidateId: candidate.id, status: "rejected", score: -999, validationLabel: run.mode === "quick" ? "EXPLORATION_ONLY" : "STANDARD_FAILED", reasons: [publicError(error)] });
        }
      }
      if (!valid) throw new Error("所有候选均未通过 DSL V2 校验");
      await persistAndAdvance(database, run, workerId, { patch: { dslValidation: { valid, total: candidates.length } }, role: "dsl_validator", title: "DSL 白名单校验完成", content: { valid, rejected: candidates.length - valid } });
      return;
    }
    if (run.stage === "optimizing") {
      const outcome = await evaluateCandidates(database, run, workerId);
      await persistAndAdvance(database, run, workerId, { patch: { optimization: { backtestsUsed: outcome.used } }, backtests: outcome.used, role: "optimizer", title: "参数搜索与确定性回测完成", content: { backtestsUsed: outcome.used, holdoutReadPolicy: "once_per_candidate" } });
      return;
    }
    if (run.stage === "adversarial_review") {
      const candidates = await loadInternalCandidates(database, run.id);
      const response = await agentCall(database, "adversarial_review", { candidates: candidates.map(item => ({ id: item.id, family: item.strategyFamily, score: item.score, label: item.validationLabel, reasons: item.rejectionReasons })) });
      await persistAndAdvance(database, run, workerId, { patch: { adversarialReview: response.output }, modelCalls: 1, role: "adversarial_review", title: "反方审查完成", content: { modelName: response.modelName, conclusion: response.output.conclusion, objections: response.output.objections, revisionRequests: response.output.revisionRequests } });
      return;
    }
    if (run.stage === "risk_review") {
      const candidates = await loadInternalCandidates(database, run.id);
      const response = await agentCall(database, "risk_review", { brief: run.brief, candidates: candidates.map(item => ({ id: item.id, score: item.score, label: item.validationLabel, reasons: item.rejectionReasons })), adversarialReview: run.result?.adversarialReview });
      await persistAndAdvance(database, run, workerId, { patch: { riskReview: response.output }, modelCalls: 1, role: "risk_review", title: "风险审核完成", content: { modelName: response.modelName, conclusion: response.output.conclusion, vetoReasons: response.output.vetoReasons, boundaries: response.output.boundaries } });
      return;
    }
    if (run.stage === "ranking") {
      const candidates = await loadInternalCandidates(database, run.id);
      const ranked = rankResearchCandidates(candidates.map(item => ({ ...item, qualified: item.validationLabel === "STANDARD_VERIFIED", score: item.score ?? -999 })));
      await setCandidateRanks(database, ranked);
      await persistAndAdvance(database, run, workerId, { patch: { ranking: ranked.map(item => ({ id: item.id, rank: item.rank, score: item.score, qualified: item.qualified })) }, role: "scoring_engine", title: "候选评分与 Top 3 排名完成", content: { topCandidates: ranked.map(item => ({ id: item.id, rank: item.rank, score: item.score, qualified: item.qualified })) } });
      return;
    }
    if (run.stage === "reporting") {
      const candidates = await loadInternalCandidates(database, run.id);
      const top = candidates.filter(item => item.rank != null).sort((a, b) => a.rank! - b.rank!).slice(0, 3);
      const qualified = top.some(item => item.validationLabel === "STANDARD_VERIFIED");
      const response = await agentCall(database, "report", { conclusion: qualified ? "QUALIFIED" : "NOT_QUALIFIED", candidates: top.map(item => ({ id: item.id, rank: item.rank, family: item.strategyFamily, score: item.score, label: item.validationLabel, failureReasons: item.rejectionReasons })), riskReview: run.result?.riskReview, adversarialReview: run.result?.adversarialReview });
      await completeResearchRun(database, {
        runId: run.id, workerId, conclusion: qualified ? "QUALIFIED" : "NOT_QUALIFIED",
        result: { report: response.output, reportModelName: response.modelName },
        event: { title: qualified ? "策略研发已完成" : "本轮没有候选通过标准验证", content: { modelName: response.modelName, conclusion: qualified ? "QUALIFIED" : "NOT_QUALIFIED", summary: response.output.summary, topCandidateIds: top.map(item => item.id) } },
      });
      return;
    }
    throw new Error(`未实现的研发阶段：${run.stage}`);
  } catch (error) {
    const message = publicError(error);
    await markResearchRunError(database, { runId: run.id, workerId, code: "STAGE_FAILED", publicMessage: message });
    throw new Error(message);
  }
}
