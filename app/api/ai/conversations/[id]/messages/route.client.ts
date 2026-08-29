import { AiApiError, aiErrorResponse, readAiJson } from "@/lib/ai-api";
import { requireAccessPermission } from "@/lib/access-control";
import { generateAssistantReply } from "@/lib/ai-assistant";
import { serializeSseEvent, splitStreamingText } from "@/lib/ai-chat-protocol";
import {
  appendAssistantMessageInTransaction,
  appendUserMessage,
  consumeAiRequestQuota,
  getConversationMessages,
  getOwnedAiConversation,
  recordAiMessageFailure,
} from "@/lib/ai-conversations";
import {
  beginClientAiInference,
  completeClientAiInference,
  estimatedClientAiCredits,
  failClientAiInference,
  readClientAiInferenceReplay,
  reconcileExpiredClientAiInferences,
} from "@/lib/client-ai-inference-service";
import { buildAssistantContext } from "@/lib/ai-context";
import { STRATEGY_REPAIR_ATTEMPTS } from "@/lib/ai-assistant";
import { classifyAssistantIntent } from "@/lib/ai-chat-protocol";
import { resolveClientPlatformLlmConfig } from "@/lib/client-platform-llm";
import { idempotencyKey } from "@/lib/commercial-request-validation";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { normalizeAiMessage } from "@/lib/ai-safety";
import { readUserAppPreference } from "@/lib/user-app-preference-service";
import type { UserAppLocale } from "@/lib/user-app-preference";

const encoder = new TextEncoder();
const disclaimers: Record<UserAppLocale, string> = {
  "en-US": "AI content is for information and strategy research only. It is not investment advice or a return promise.",
  "zh-CN": "AI 内容仅用于信息与策略研究，不构成投资建议或收益承诺。",
  "zh-TW": "AI 內容僅供資訊與策略研究，不構成投資建議或收益承諾。",
  "ru-RU": "Материалы ИИ предназначены только для информации и исследования стратегий, а не для инвестиционных рекомендаций или обещаний доходности.",
  "es-ES": "El contenido de IA es solo informativo y para investigar estrategias; no constituye asesoramiento de inversión ni una promesa de rentabilidad.",
  "ja-JP": "AI の内容は情報提供と戦略研究のみを目的とし、投資助言や収益の保証ではありません。",
  "ko-KR": "AI 콘텐츠는 정보 제공 및 전략 연구용이며 투자 조언이나 수익 약속이 아닙니다.",
};

type StoredChatResult = {
  text: string;
  meta: { conversationId: string; title: string; userMessage: unknown; inferenceRequestId?: string };
  done: { message: unknown; mode: "ai_provider"; suggestedAction: "strategy" | null; disclaimer: string };
};

function storedChatResult(value: unknown): StoredChatResult {
  if (!value || typeof value !== "object") throw new AiApiError("AI_RESULT_INVALID", "AI 请求结果无法恢复", 500);
  const result = value as Partial<StoredChatResult>;
  if (
    typeof result.text !== "string" || !result.text
    || !result.meta || typeof result.meta.conversationId !== "string" || typeof result.meta.title !== "string"
    || !result.done || result.done.mode !== "ai_provider"
  ) throw new AiApiError("AI_RESULT_INVALID", "AI 请求结果无法恢复", 500);
  return result as StoredChatResult;
}

function streamChatResult(result: StoredChatResult) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(serializeSseEvent(event, data)));
      };
      send("meta", result.meta);
      for (const text of splitStreamingText(result.text)) send("delta", { text });
      send("done", result.done);
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const { user, session } = await requireAccessPermission(request, "client.paper.view");
    const { id } = await params;
    const body = await readAiJson(request);
    let content: string;
    try {
      content = normalizeAiMessage(body.message);
    } catch (error) {
      throw new AiApiError(
        "VALIDATION_ERROR",
        error instanceof Error ? error.message : "消息格式无效",
        400,
      );
    }
    const conversation = await getOwnedAiConversation(user.id, id);
    const pool = await getPostgresPool();
    const preference = await readUserAppPreference(pool, session.tokenHash);
    const locale = preference.locale;
    const disclaimer = disclaimers[locale];
    const key = idempotencyKey(request);
    const correlationRequestId = request.headers.get("x-request-id")?.trim().slice(0, 160) || crypto.randomUUID();
    await reconcileExpiredClientAiInferences(pool, {
      userId: user.id,
      requestId: correlationRequestId,
    });
    const requestPayload = { conversationId: id, message: content, locale };
    const replayed = await readClientAiInferenceReplay(pool, {
      userId: user.id,
      operation: "assistant_message",
      idempotencyKey: key,
      payload: requestPayload,
    });
    if (replayed) return streamChatResult(storedChatResult(replayed.result));
    const config = await resolveClientPlatformLlmConfig(pool, "report");
    if (!config) {
      throw new AiApiError(
        "PLATFORM_MODEL_NOT_CONFIGURED",
        "平台 report 模型绑定尚未配置或密钥不可解密，当前请求未调用模型也未扣费",
        503,
      );
    }
    const claimed = await beginClientAiInference(pool, {
      userId: user.id,
      operation: "assistant_message",
      idempotencyKey: key,
      payload: requestPayload,
      modelRevisionId: config.revisionId,
      // 策略研究意图可能触发 DSL 修复循环（见 lib/ai-assistant.ts）。
      // 预留必须覆盖最坏情况下的全部调用，否则结算会因实耗超过预留被拒。
      // 预留是临时冻结，未用部分在结算时原路退回。
      estimatedCredits: estimatedClientAiCredits(900)
        * BigInt(classifyAssistantIntent(content) === "strategy_research" ? 1 + STRATEGY_REPAIR_ATTEMPTS : 1),
      requestId: correlationRequestId,
    });
    if (claimed.state === "succeeded") return streamChatResult(storedChatResult(claimed.result));

    let savedUser;
    try {
      await consumeAiRequestQuota(user.id, content.length);
      savedUser = await appendUserMessage(user.id, conversation, content);
    } catch (error) {
      const known = error instanceof AiApiError ? error : new AiApiError("AI_REQUEST_SETUP_FAILED", "AI 请求未开始，Credits 预留已释放", 500);
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

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(serializeSseEvent(event, data)));
        };
        send("meta", {
          conversationId: id,
          title: savedUser.title,
          userMessage: savedUser.message,
          inferenceRequestId: claimed.requestId,
        });
        let committed = false;
        try {
          const history = await getConversationMessages(user.id, id);
          const researchPrompt = history
            .filter((message) => message.role === "user")
            .slice(-6)
            .map((message) => message.content)
            .join("\n");
          const context = await buildAssistantContext(user.id, researchPrompt || content);
          const result = await generateAssistantReply({
            latestMessage: content,
            history: history.map((message) => ({ role: message.role, content: message.content })),
            context,
            config,
            locale: preference.locale,
            signal: request.signal,
          });
          if (!("metering" in result)) throw new Error("AI_PROVIDER_METERING_MISSING");
          const completed = await completeClientAiInference(pool, {
            requestId: claimed.requestId,
            reservationId: claimed.reservationId,
            idempotencyKey: key,
            correlationRequestId,
            trustedUsage: result.metering,
            persistResult: async (client) => {
              const assistantMessage = await appendAssistantMessageInTransaction(client, {
                userId: user.id,
                conversationId: id,
                content: result.text,
                providerName: result.provider,
                model: result.model,
                suggestedAction: result.suggestedAction,
              });
              return {
                text: result.text,
                meta: {
                  conversationId: id,
                  title: savedUser.title,
                  userMessage: savedUser.message,
                  inferenceRequestId: claimed.requestId,
                },
                done: {
                  message: assistantMessage,
                  mode: "ai_provider" as const,
                  suggestedAction: result.suggestedAction || null,
                  disclaimer,
                },
              };
            },
          });
          const stored = storedChatResult(completed.result);
          committed = true;
          for (const text of splitStreamingText(stored.text)) send("delta", { text });
          send("done", stored.done);
        } catch (error) {
          if (!committed) {
            const errorCode = error && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code || "")
              : "";
            const cancelled = request.signal.aborted
              || errorCode === "AI_REQUEST_CANCELLED"
              || (error instanceof Error && error.name === "AbortError");
            let released = false;
            try {
              await failClientAiInference(pool, {
                requestId: claimed.requestId,
                reservationId: claimed.reservationId,
                idempotencyKey: key,
                correlationRequestId,
                errorCode: cancelled ? "AI_REQUEST_CANCELLED" : "AI_REPLY_FAILED",
                errorMessage: cancelled
                  ? "AI 请求已由用户取消，Credits 预留已释放"
                  : "AI 回复未完成，Credits 预留已释放，请使用新的请求重试",
                errorStatus: cancelled ? 409 : 502,
              });
              released = true;
            } catch {
              // Keep the request terminal/in-progress rather than risk another provider call.
            }
            await recordAiMessageFailure(user.id, id).catch(() => undefined);
            try {
              send("error", {
                code: released
                  ? cancelled ? "AI_REQUEST_CANCELLED" : "AI_REPLY_FAILED"
                  : "AI_RECONCILIATION_REQUIRED",
                message: released
                  ? cancelled
                    ? "AI 生成已取消，Credits 未扣除"
                    : "AI 回复未完成，Credits 未扣除，请使用新的请求重试"
                  : "AI 回复未完成，Credits 结算状态待平台核对；相同请求不会再次调用模型",
              });
            } catch {
              // The client disconnected; the failed request remains terminal and cannot call the provider again.
            }
          }
        } finally {
          try { controller.close(); } catch { /* stream already cancelled */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
