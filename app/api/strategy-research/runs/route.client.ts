import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { exchangeAccounts } from "@/db/schema";
import { getOwnedAiConversation } from "@/lib/ai-conversations";
import { readClientFeatureFlagDecision } from "@/lib/active-feature-flags";
import { snapshotAgentRoleBindings } from "@/lib/agent-model-profiles";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { createPerpetualMarketAdapter, type PerpetualExchange } from "@/lib/perpetual-market-adapters";
import { createResearchRun, listOwnedResearchRuns, pauseResearchRunForMissingRoles } from "@/lib/postgres-research-queue";
import { readResearchJson, requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { parseStrategyResearchTarget } from "@/lib/research-target";
import type { ResearchMode } from "@/packages/domain/src/research-validation";
import { runtimeSetting } from "@/lib/runtime-setting";

async function requireStrategyResearchEnabled() {
  const environmentEnabled = runtimeSetting("STRATEGY_RESEARCH_ENABLED") === "true";
  if (!environmentEnabled) throw new ResearchApiError("FEATURE_DISABLED", "多 Agent 策略研发功能尚未开放", 503);
  await ensureDatabaseSchema();
  const pool = await getPostgresPool();
  const decision = await readClientFeatureFlagDecision(pool, {
    key: "client.strategy_research",
    environmentEnabled,
  });
  if (!decision.enabled) throw new ResearchApiError("FEATURE_DISABLED", "多 Agent 策略研发功能尚未开放", 503);
  return pool;
}

export async function GET(request: Request) {
  try {
    const pool = await requireStrategyResearchEnabled();
    const user = await requireResearchUser(request, ["customer"]);
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") || "latest";
    const limitValue = Number(url.searchParams.get("limit") || 10);
    if (!['latest', 'active'].includes(scope) || !Number.isInteger(limitValue) || limitValue < 1 || limitValue > 20) {
      throw new ResearchApiError("VALIDATION_ERROR", "研发任务查询参数无效", 422);
    }
    const runs = await listOwnedResearchRuns(pool, {
      ownerUserId: user.id,
      limit: limitValue,
      activeOnly: scope === "active",
    });
    return Response.json({
      runs: runs.map(run => ({
        id: run.id,
        exchangeAccountId: run.exchangeAccountId,
        mode: run.mode,
        stage: run.stage,
        status: run.status,
        progress: run.progress,
        brief: run.brief,
        finalConclusion: run.finalConclusion,
        lastErrorCode: run.lastErrorCode,
        lastErrorMessage: run.lastErrorMessage,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const pool = await requireStrategyResearchEnabled();
    const user = await requireResearchUser(request, ["customer"]);
    const body = await readResearchJson(request, 65_536);
    const conversationId = String(body.conversationId ?? "").trim() || null;
    const exchangeAccountId = String(body.exchangeAccountId ?? "").trim();
    const mode = String(body.mode ?? "") as ResearchMode;
    const idempotencyKey = String(request.headers.get("idempotency-key") ?? "").trim();
    if (!exchangeAccountId) {
      throw new ResearchApiError("VALIDATION_ERROR", "交易所账户为必填", 422);
    }
    if (!(["quick", "standard", "deep"] as const).includes(mode)) {
      throw new ResearchApiError("VALIDATION_ERROR", "运行模式无效", 422);
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new ResearchApiError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 长度必须为 8–128", 400);
    }
    const target = parseStrategyResearchTarget(body);
    if (conversationId) {
      const conversation = await getOwnedAiConversation(user.id, conversationId);
      if (conversation.purpose !== "strategy") {
        throw new ResearchApiError("INVALID_CONVERSATION", "当前会话不是策略研究会话", 409);
      }
    }
    const account = (await getDb().select().from(exchangeAccounts).where(and(
      eq(exchangeAccounts.id, exchangeAccountId),
      eq(exchangeAccounts.customerId, user.id),
    )).limit(1))[0];
    if (!account || account.status !== "active" || !account.canRead || account.withdrawalAuthorized) {
      throw new ResearchApiError("INVALID_EXCHANGE_ACCOUNT", "交易所账户不存在、尚未通过连通检测、无只读权限或包含提现权限", 422);
    }
    if (!["OKX", "BINANCE", "BYBIT"].includes(account.exchange.toUpperCase())) {
      throw new ResearchApiError("UNSUPPORTED_EXCHANGE", "策略研发首期仅支持 OKX、Binance 和 Bybit 永续", 422);
    }

    const exchange = account.exchange.toLowerCase() as PerpetualExchange;
    let instrument;
    try {
      instrument = await createPerpetualMarketAdapter(exchange).getInstrument({ symbol: target.symbol });
    } catch (error) {
      throw new ResearchApiError("INVALID_INSTRUMENT", "所选永续合约不存在或交易规则无效", 422, {
        exchange,
        instrumentId: target.instrumentId,
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
    if (instrument.status !== "live"
      || (target.source === "target" && instrument.exchangeSymbol !== target.instrumentId)) {
      throw new ResearchApiError("INVALID_INSTRUMENT", "所选永续合约与账户交易所不匹配或当前不可交易", 422, {
        exchange,
        instrumentId: target.instrumentId,
      });
    }
    const canonicalTarget = {
      instrumentId: instrument.exchangeSymbol,
      symbol: instrument.symbol,
      timeframe: target.timeframe,
      direction: target.direction,
    };

    const roleSnapshot = await snapshotAgentRoleBindings(pool);
    let run = await createResearchRun(pool, {
      ownerUserId: user.id,
      conversationId,
      exchangeAccountId,
      mode,
      brief: {
        ...(body.brief as Record<string, unknown>),
        ...canonicalTarget,
        target: canonicalTarget,
        exchange,
        instrumentRules: {
          tickSize: instrument.tickSize,
          lotSize: instrument.lotSize,
          fundingIntervalHours: instrument.fundingIntervalHours,
        },
      },
      agentRoleSnapshot: roleSnapshot.roles,
      idempotencyKey,
    });
    const missing = roleSnapshot.missingRoles;
    if (missing.length && run.status === "queued") {
      run = await pauseResearchRunForMissingRoles(pool, { runId: run.id, missingRoles: missing });
    }
    return Response.json({ runId: run.id, status: run.status }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
