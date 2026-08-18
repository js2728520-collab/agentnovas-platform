import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { exchangeAccounts } from "@/db/schema";
import { getOwnedAiConversation } from "@/lib/ai-conversations";
import { missingAgentRoles } from "@/lib/agent-model-profiles";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { getPostgresPool } from "@/lib/postgres";
import { createResearchRun, pauseResearchRunForMissingRoles } from "@/lib/postgres-research-queue";
import { readResearchJson, requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import type { ResearchMode } from "@/lib/research-validation";
import { runtimeSetting } from "@/lib/runtime-setting";

function enabled() {
  return runtimeSetting("STRATEGY_RESEARCH_ENABLED") === "true";
}

export async function POST(request: Request) {
  try {
    if (!enabled()) throw new ResearchApiError("FEATURE_DISABLED", "多 Agent 策略研发功能尚未开放", 503);
    await ensureD1Schema();
    const user = await requireResearchUser(request, ["customer"]);
    const body = await readResearchJson(request, 65_536);
    const conversationId = String(body.conversationId ?? "").trim();
    const exchangeAccountId = String(body.exchangeAccountId ?? "").trim();
    const mode = String(body.mode ?? "") as ResearchMode;
    const idempotencyKey = String(request.headers.get("idempotency-key") ?? "").trim();
    if (!conversationId || !exchangeAccountId) {
      throw new ResearchApiError("VALIDATION_ERROR", "会话和交易所账户为必填", 422);
    }
    if (!(["quick", "standard", "deep"] as const).includes(mode)) {
      throw new ResearchApiError("VALIDATION_ERROR", "运行模式无效", 422);
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new ResearchApiError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 长度必须为 8–128", 400);
    }
    if (!body.brief || typeof body.brief !== "object" || Array.isArray(body.brief)) {
      throw new ResearchApiError("VALIDATION_ERROR", "brief 必须是对象", 422);
    }
    const conversation = await getOwnedAiConversation(user.id, conversationId);
    if (conversation.purpose !== "strategy") {
      throw new ResearchApiError("INVALID_CONVERSATION", "当前会话不是策略研究会话", 409);
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

    const pool = await getPostgresPool();
    let run = await createResearchRun(pool, {
      ownerUserId: user.id,
      conversationId,
      exchangeAccountId,
      mode,
      brief: { ...(body.brief as Record<string, unknown>), exchange: account.exchange.toLowerCase() },
      idempotencyKey,
    });
    const missing = await missingAgentRoles(pool);
    if (missing.length && run.status === "queued") {
      run = await pauseResearchRunForMissingRoles(pool, { runId: run.id, missingRoles: missing });
    }
    return Response.json({ runId: run.id, status: run.status }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
