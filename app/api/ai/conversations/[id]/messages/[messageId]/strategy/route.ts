import { AiApiError, aiErrorResponse, requireAiCustomer } from "@/lib/ai-api";
import { getOwnedAiConversation, getOwnedAiMessage } from "@/lib/ai-conversations";
import { strategyDraftFromAiMessage } from "@/lib/ai-strategy-save";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { createStrategyDraft } from "@/lib/strategy-drafts";
import { StrategyDslValidationError } from "@/lib/strategy-dsl";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    await ensureD1Schema();
    const user = await requireAiCustomer(request);
    const { id, messageId } = await params;
    if (!uuidPattern.test(id) || !uuidPattern.test(messageId)) {
      throw new AiApiError("INVALID_RESOURCE_ID", "对话或回复 ID 格式无效", 400);
    }
    await getOwnedAiConversation(user.id, id);
    const message = await getOwnedAiMessage(user.id, id, messageId);
    if (message.role !== "assistant") {
      throw new AiApiError("INVALID_STRATEGY_MESSAGE", "只能保存 Agent 生成的策略回复", 409);
    }
    if (message.generationMode !== "ai_provider" && message.generationMode !== "guided_rules") {
      throw new AiApiError("INVALID_STRATEGY_MESSAGE", "当前回复没有可追溯的策略生成记录", 409);
    }

    let draft;
    try {
      draft = strategyDraftFromAiMessage(message.content);
    } catch (error) {
      throw new AiApiError(
        "STRATEGY_DSL_NOT_FOUND",
        "此回复中没有可保存的有效策略 DSL，请先让 Agent 生成完整策略",
        422,
        error instanceof StrategyDslValidationError ? error.issues : [],
      );
    }

    const saved = await createStrategyDraft({
      id: `ai-message-${message.id}`,
      userId: user.id,
      name: draft.name,
      summary: draft.summary,
      riskLevel: draft.riskLevel,
      publicationMode: draft.publicationMode,
      specification: draft.specification,
      conversationId: id,
      source: message.generationMode,
      sourceMessageId: message.id,
      conversionWarnings: draft.conversionWarnings,
    });
    return Response.json({
      strategy: { id: saved.id, status: saved.status, version: saved.version },
      message: saved.created ? "策略已保存到我的策略" : "该策略已经保存到我的策略",
      warnings: draft.conversionWarnings,
    }, { status: saved.created ? 201 : 200 });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
