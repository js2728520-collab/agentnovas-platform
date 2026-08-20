import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { strategyDslToRuntime } from "@/lib/strategy-dsl";
import {
  createStrategyDeployment,
  StrategyDeploymentIdempotencyConflictError,
} from "@/lib/strategy-runtime-repository";

export async function POST(request: Request, { params }: {
  params: Promise<{ strategyId: string; versionId: string }>;
}) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { strategyId, versionId } = await params;
    const body = await readResearchJson(request);
    const exchangeAccountId = String(body.exchangeAccountId ?? "").trim();
    const mode = String(body.mode ?? "");
    const idempotencyKey = String(request.headers.get("idempotency-key") ?? "").trim();
    if (!exchangeAccountId) throw new ResearchApiError("VALIDATION_ERROR", "交易所数据账户为必填", 422, { fields: ["exchangeAccountId"] });
    if (mode !== "shadow" && mode !== "paper") {
      throw new ResearchApiError("VALIDATION_ERROR", "部署模式仅支持 shadow 或 paper", 422, { fields: ["mode"] });
    }
    if (body.riskAcknowledged !== true) {
      throw new ResearchApiError("RISK_ACKNOWLEDGEMENT_REQUIRED", "请先确认历史表现不代表未来收益", 422, { fields: ["riskAcknowledged"] });
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new ResearchApiError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 长度必须为 8–128", 400);
    }
    const pool = await getPostgresPool();
    const target = (await pool.query<{
      author_user_id: string;
      validation_label: "UNVERIFIED" | "EXPLORATION_ONLY" | "STANDARD_FAILED" | "STANDARD_VERIFIED";
      specification_json: string;
    }>(`
      SELECT strategy.author_user_id, strategy.validation_label, version.specification_json
      FROM community_strategies AS strategy
      JOIN strategy_versions AS version ON version.strategy_id = strategy.id
      WHERE strategy.id = $1 AND version.id = $2 AND strategy.author_user_id = $3
      LIMIT 1
    `, [strategyId, versionId, user.id])).rows[0];
    if (!target) throw new ResearchApiError("STRATEGY_VERSION_NOT_FOUND", "策略版本不存在或不属于当前客户", 404);
    let specification;
    try {
      specification = strategyDslToRuntime(JSON.parse(target.specification_json));
    } catch {
      throw new ResearchApiError("INVALID_STRATEGY_VERSION", "策略版本无法通过受限 DSL 校验", 422);
    }
    const requestedPositionSize = body.positionSizePct === undefined ? specification.risk.positionSizePct : Number(body.positionSizePct);
    const maximumStopLoss = Math.max(
      specification.legs.long?.stopLossPct ?? 0,
      specification.legs.short?.stopLossPct ?? 0,
    );
    const requestedStopLoss = body.stopLossPct === undefined ? maximumStopLoss : Number(body.stopLossPct);
    if (!Number.isFinite(requestedPositionSize) || requestedPositionSize < 0.1 || requestedPositionSize > specification.risk.positionSizePct) {
      throw new ResearchApiError("VALIDATION_ERROR", "资金比例不能超过策略版本的风险上限", 422, { fields: ["positionSizePct"] });
    }
    if (!Number.isFinite(requestedStopLoss) || requestedStopLoss < 0.1 || requestedStopLoss > maximumStopLoss) {
      throw new ResearchApiError("VALIDATION_ERROR", "止损比例只能收紧，不能超过策略版本上限", 422, { fields: ["stopLossPct"] });
    }
    const account = (await pool.query<{
      id: string; exchange: string; status: string; can_read: number | boolean;
    }>(`
      SELECT id, exchange, status, can_read FROM exchange_accounts
      WHERE id = $1 AND customer_id = $2 LIMIT 1
    `, [exchangeAccountId, user.id])).rows[0];
    if (!account || account.status !== "active" || !account.can_read || !["OKX", "BINANCE", "BYBIT"].includes(account.exchange.toUpperCase())) {
      throw new ResearchApiError("INVALID_EXCHANGE_ACCOUNT", "交易所账户不存在、不可读或不支持永续数据", 422);
    }
    const deployment = await createStrategyDeployment(pool, {
      ownerUserId: user.id,
      strategyId,
      strategyVersionId: versionId,
      exchangeAccountId,
      mode,
      validationLabel: target.validation_label,
      idempotencyKey,
      riskAcknowledged: true,
      positionSizePct: requestedPositionSize,
      stopLossPctOverride: requestedStopLoss,
    });
    return Response.json({ deployment }, { status: 202 });
  } catch (error) {
    if (error instanceof StrategyDeploymentIdempotencyConflictError) {
      return researchErrorResponse(new ResearchApiError(
        "IDEMPOTENCY_CONFLICT",
        error.message,
        409,
      ), request);
    }
    return researchErrorResponse(error, request);
  }
}
