import { AiApiError, aiErrorResponse, readAiJson } from "@/lib/ai-api";
import { requireAccessPermission } from "@/lib/access-control";
import {
  consumeAiRequestQuota,
  getConversationMessages,
  getOwnedAiConversation,
  recordStrategyGenerationInTransaction,
} from "@/lib/ai-conversations";
import {
  beginClientAiInference,
  completeClientAiInference,
  estimatedClientAiCredits,
  failClientAiInference,
  readClientAiInferenceReplay,
  reconcileExpiredClientAiInferences,
} from "@/lib/client-ai-inference-service";
import { resolveClientPlatformLlmConfig } from "@/lib/client-platform-llm";
import { idempotencyKey } from "@/lib/commercial-request-validation";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import {
  generateStrategyProposal,
  normalizeStrategyBrief,
} from "@/lib/ai-strategy-generation";
import { StrategyDslValidationError } from "@/packages/domain/src/strategy-dsl";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "client.paper.view");
    const body = await readAiJson(request);
    const conversationId = String(body.conversationId || "").trim();
    if (!conversationId) throw new AiApiError("VALIDATION_ERROR", "缺少策略对话 ID", 400);
    const conversation = await getOwnedAiConversation(user.id, conversationId);
    if (conversation.purpose !== "strategy") {
      throw new AiApiError("INVALID_CONVERSATION_PURPOSE", "当前对话不是策略研究对话", 409);
    }

    let brief;
    try {
      brief = normalizeStrategyBrief(body.brief);
    } catch (error) {
      throw new AiApiError(
        "VALIDATION_ERROR",
        error instanceof Error ? error.message : "策略问卷格式无效",
        400,
      );
    }
    const pool = await getPostgresPool();
    const key = idempotencyKey(request);
    const correlationRequestId = request.headers.get("x-request-id")?.trim().slice(0, 160) || crypto.randomUUID();
    await reconcileExpiredClientAiInferences(pool, {
      userId: user.id,
      requestId: correlationRequestId,
    });
    const requestPayload = { conversationId, brief };
    const replayed = await readClientAiInferenceReplay(pool, {
      userId: user.id,
      operation: "strategy_generation",
      idempotencyKey: key,
      payload: requestPayload,
    });
    if (replayed) return Response.json(replayed.result);
    const config = await resolveClientPlatformLlmConfig(pool, "proposal_a");
    if (!config) {
      throw new AiApiError(
        "PLATFORM_MODEL_NOT_CONFIGURED",
        "平台 proposal_a 模型绑定尚未配置或密钥不可解密，当前请求未调用模型也未扣费",
        503,
      );
    }
    const claimed = await beginClientAiInference(pool, {
      userId: user.id,
      operation: "strategy_generation",
      idempotencyKey: key,
      payload: requestPayload,
      modelRevisionId: config.revisionId,
      estimatedCredits: estimatedClientAiCredits(1_200),
      requestId: correlationRequestId,
    });
    if (claimed.state === "succeeded") return Response.json(claimed.result);

    try {
      const inputChars = JSON.stringify(brief).length;
      await consumeAiRequestQuota(user.id, inputChars);
      const history = await getConversationMessages(user.id, conversationId);
      const generated = await generateStrategyProposal({
        brief,
        history: history.map((message) => ({ role: message.role, content: message.content })),
        config,
        invocationId: claimed.requestId,
      });
      if (!("metering" in generated) || !generated.metering) throw new Error("AI_PROVIDER_METERING_MISSING");
      const { metering, ...publicResult } = generated;
      const specificationJson = JSON.stringify(publicResult.specification);
      const completed = await completeClientAiInference(pool, {
        requestId: claimed.requestId,
        reservationId: claimed.reservationId,
        idempotencyKey: key,
        correlationRequestId,
        trustedUsage: metering,
        persistResult: async (client) => {
          const generationId = await recordStrategyGenerationInTransaction(client, {
            userId: user.id,
            conversationId,
            mode: "ai_provider",
            specificationJson,
          });
          return {
            ...publicResult,
            conversationId,
            generationId,
            disclaimer: "候选规则仅用于研究；保存为草稿并完成历史回测后，仍需人工确认。不会自动下单。",
          };
        },
      });
      return Response.json(completed.result);
    } catch (error) {
      const known = error instanceof StrategyDslValidationError
        ? new AiApiError("DSL_VALIDATION_FAILED", "AI 生成的策略未通过规则校验，Credits 预留已释放", 422, error.issues)
        : error instanceof AiApiError
          ? error
          : new AiApiError("AI_GENERATION_FAILED", "AI 策略生成未完成，Credits 预留已释放，请使用新的请求重试", 502);
      await failClientAiInference(pool, {
        requestId: claimed.requestId,
        reservationId: claimed.reservationId,
        idempotencyKey: key,
        correlationRequestId,
        errorCode: known.code,
        errorMessage: known.message,
        errorStatus: known.status,
      });
      throw known;
    }
  } catch (error) {
    return aiErrorResponse(error);
  }
}
