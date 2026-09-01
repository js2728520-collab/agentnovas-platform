import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import {
  communityStrategies,
  platformStrategySubscriptions,
  strategySubscriptions,
  trades,
} from "@/db/schema";
import {
  classifyAssistantIntent,
  intentNeedsDecisions,
  intentNeedsPlatformFacts,
  type AssistantContext,
} from "@/lib/ai-chat-protocol";
import { getPostgresPool } from "@/lib/postgres";
import { buildPlatformFactSnapshot } from "@/packages/contracts/src/platform-facts";
import { officialTradingHallStrategies } from "@/packages/contracts/src/trading-hall";
import { summarizeResearchCandles, type ResearchCandle } from "@/lib/ai-research";
import { fetchPublicMarketJson, publicMarketProviderName } from "@/lib/public-market-source";

const allowedMarketSymbols = new Set([
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "TRX",
  "DOT", "LTC", "BCH", "TON", "SUI", "APT", "NEAR", "ARB", "OP", "UNI",
]);
// 策略卡名称的唯一真源是 packages/contracts，这里不留第二份常量。
const platformStrategyName = (code: string) =>
  officialTradingHallStrategies.find((strategy) => strategy.code === code)?.name ?? code;

function requestedSymbol(message: string) {
  const normalized = message.toUpperCase();
  for (const symbol of allowedMarketSymbols) {
    if (new RegExp(`(^|[^A-Z])${symbol}(?:\\s*[/_-]?\\s*USDT)?([^A-Z]|$)`).test(normalized)) return `${symbol}USDT`;
  }
  return null;
}

async function marketContext(message: string): Promise<AssistantContext["market"]> {
  const symbol = requestedSymbol(message);
  if (!symbol) return null;
  try {
    const { data, base } = await fetchPublicMarketJson<unknown[]>(
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=120`,
      4_000,
    );
    const candles = data.flatMap((row): ResearchCandle[] => {
      if (!Array.isArray(row) || row.length < 7) return [];
      const values = [row[0], row[1], row[2], row[3], row[4], row[5], row[6]].map(Number);
      if (!values.every(Number.isFinite)) return [];
      return [{
        openTime: values[0],
        open: values[1],
        high: values[2],
        low: values[3],
        close: values[4],
        volume: values[5],
        closeTime: values[6],
      }];
    });
    return summarizeResearchCandles(symbol, candles, publicMarketProviderName(base));
  } catch {
    // Preserve the lightweight ticker fallback when the K-line endpoint is unavailable.
  }
  try {
    const { data, base } = await fetchPublicMarketJson<{
      lastPrice: string;
      priceChangePercent: string;
      highPrice: string;
      lowPrice: string;
    }>(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, 4_000);
    const values = [data.lastPrice, data.priceChangePercent, data.highPrice, data.lowPrice].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return {
      symbol,
      price: values[0],
      change24hPct: values[1],
      high24h: values[2],
      low24h: values[3],
      source: publicMarketProviderName(base),
    };
  } catch {
    return null;
  }
}

type DecisionRow = {
  strategy_code: string;
  symbol: string;
  cycle_id: string | null;
  candle_close_time: Date | null;
  decision_json: { action?: string; riskApproved?: boolean; rejectionReasons?: string[] } | null;
};

/**
 * 该客户最近的决策轮摘要。
 *
 * 只取每张策略卡最新的一轮，够回答「这一轮为什么没开仓」。完整视图在
 * /api/trading-hall；这里刻意做成轻量查询，因为它进的是提示词，不是页面。
 */
async function decisionContext(userId: string): Promise<AssistantContext["decisions"]> {
  const pool = await getPostgresPool();
  const rounds = await pool.query<DecisionRow>(`
    SELECT DISTINCT ON (mapping.strategy_code)
      mapping.strategy_code, mapping.symbol,
      cycle.id AS cycle_id, cycle.candle_close_time, cycle.decision_json
    FROM strategy_deployments AS deployment
    JOIN platform_strategy_migration_map AS mapping
      ON mapping.strategy_id = deployment.strategy_id
     AND mapping.strategy_version_id = deployment.strategy_version_id
    LEFT JOIN LATERAL (
      SELECT * FROM strategy_runtime_cycles
      WHERE deployment_id = deployment.id
      ORDER BY sequence DESC LIMIT 1
    ) AS cycle ON true
    WHERE deployment.owner_user_id = $1
    ORDER BY mapping.strategy_code, deployment.updated_at DESC, deployment.id DESC
  `, [userId]);

  const cycleIds = rounds.rows.flatMap((row) => row.cycle_id ? [row.cycle_id] : []);
  if (cycleIds.length === 0) return [];
  const events = await pool.query<{ cycle_id: string; role: string; conclusion: string }>(`
    SELECT cycle_id, role, conclusion
    FROM strategy_runtime_events
    WHERE cycle_id = ANY($1::text[])
    ORDER BY cycle_id, sequence
  `, [cycleIds]);
  const stagesByCycle = new Map<string, Array<{ role: string; conclusion: string }>>();
  for (const event of events.rows) {
    stagesByCycle.set(event.cycle_id, [
      ...(stagesByCycle.get(event.cycle_id) ?? []),
      { role: event.role, conclusion: event.conclusion },
    ]);
  }

  return rounds.rows.flatMap((row) => row.cycle_id ? [{
    decisionRoundId: row.cycle_id,
    strategyName: platformStrategyName(row.strategy_code),
    symbol: row.symbol,
    action: row.decision_json?.action ?? "monitoring",
    riskApproved: row.decision_json?.riskApproved !== false,
    rejectionReasons: row.decision_json?.rejectionReasons ?? [],
    decidedAt: row.candle_close_time?.toISOString() ?? null,
    stages: stagesByCycle.get(row.cycle_id) ?? [],
  }] : []);
}

export async function buildAssistantContext(userId: string, message: string): Promise<AssistantContext> {
  const db = getDb();
  const intent = classifyAssistantIntent(message);
  const [tradeRows, communityFollowing, platformFollowing, market, decisions] = await Promise.all([
    db.select({ symbol: trades.symbol })
      .from(trades)
      .where(and(eq(trades.customerId, userId), isNull(trades.closedAt)))
      .limit(1_000),
    db.select({ name: communityStrategies.name })
      .from(strategySubscriptions)
      .innerJoin(communityStrategies, eq(communityStrategies.id, strategySubscriptions.strategyId))
      .where(and(eq(strategySubscriptions.customerId, userId), eq(strategySubscriptions.status, "active")))
      .limit(20),
    db.select({ strategyCode: platformStrategySubscriptions.strategyCode })
      .from(platformStrategySubscriptions)
      .where(and(eq(platformStrategySubscriptions.customerId, userId), eq(platformStrategySubscriptions.status, "active")))
      .limit(20),
    marketContext(message),
    intentNeedsDecisions(intent) ? decisionContext(userId).catch(() => []) : Promise.resolve(undefined),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    evidencePriority: intent === "market_analysis"
      ? "优先引用 market 的时间、周期、价格和技术指标；字段缺失时明确证据不足。"
      : intent === "decision_analysis"
        ? "优先引用 decisions 的阶段结论与拒绝理由；不得以模型判断补齐缺失阶段。"
        : intent === "platform_info"
          ? "优先引用 platform 的合同事实；不得使用平台快照外的数字或规则。"
          : intent === "strategy_research"
            ? "优先使用会话工作记忆；只识别会改变策略结论的缺失边界。"
            : "优先引用与当前问题直接相关的服务端证据；缺少证据时明确说明。",
    market,
    // 平台事实是静态的，从合同常量派生，没有 I/O。
    ...(intentNeedsPlatformFacts(intent) ? { platform: buildPlatformFactSnapshot() } : {}),
    ...(decisions ? { decisions } : {}),
    portfolio: {
      openPositions: tradeRows.length,
      positionSymbols: [...new Set(tradeRows.map((row) => row.symbol))].slice(0, 20),
      followedStrategies: [
        ...communityFollowing.map((row) => row.name),
        ...platformFollowing.map((row) => platformStrategyName(row.strategyCode)),
      ].slice(0, 20),
    },
  };
}
