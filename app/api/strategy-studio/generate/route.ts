import { AiApiError, aiErrorResponse, readAiJson, requireAiCustomer } from "@/lib/ai-api";
import {
  consumeAiRequestQuota,
  getConversationMessages,
  getOwnedAiConversation,
  recordStrategyGeneration,
} from "@/lib/ai-conversations";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { resolveLlmConfig } from "@/lib/llm-config";
import {
  generateStrategyProposal,
  normalizeStrategyBrief,
} from "@/lib/ai-strategy-generation";
import { StrategyDslValidationError } from "@/lib/strategy-dsl";

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
    const user = await requireAiCustomer(request);
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
    const inputChars = JSON.stringify(brief).length;
    await consumeAiRequestQuota(user.id, inputChars);
    const [history, config] = await Promise.all([
      getConversationMessages(user.id, conversationId),
      resolveLlmConfig(user.id),
    ]);

    let result;
    try {
      result = await generateStrategyProposal({
        brief,
        history: history.map((message) => ({ role: message.role, content: message.content })),
        config,
      });
    } catch (error) {
      if (error instanceof StrategyDslValidationError) {
        throw new AiApiError("DSL_VALIDATION_FAILED", "AI 生成的策略未通过规则校验", 422, error.issues);
      }
      throw new AiApiError("AI_GENERATION_FAILED", "AI 策略生成暂时不可用，请稍后重试", 502);
    }
    const specificationJson = JSON.stringify(result.specification);
    await recordStrategyGeneration({
      userId: user.id,
      conversationId,
      mode: result.mode,
      specificationJson,
    });
    return Response.json({
      ...result,
      conversationId,
      disclaimer: "候选规则仅用于研究；保存为草稿并完成历史回测后，仍需人工确认。不会自动下单。",
    });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
