import { AiApiError, aiErrorResponse } from "@/lib/ai-api";
import { requireAccessPermission } from "@/lib/access-control";
import { getOwnedAiConversation, getOwnedAiMessage } from "@/lib/ai-conversations";
import { strategyDraftFromAiMessage } from "@/lib/ai-strategy-save";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { createStrategyDraft } from "@/lib/strategy-drafts";
import { runStrategySmokeTest } from "@/lib/backtest-engine";
import { describeStrategySmokeVerdict } from "@/packages/domain/src/strategy-smoke-test";
import { StrategyDslValidationError } from "@/packages/domain/src/strategy-dsl";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "client.paper.view");
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

    // 保存前的冒烟回测：只验证「跑得完且会触发信号」，不看收益。
    // 静态校验挡不住「指标周期比 K 线还长」「条件永远不成立」这两类问题——
    // 它们会让保存看起来成功，等客户部署后才发现什么都没发生。
    const smoke = await runStrategySmokeTest(draft.specification);
    if (smoke.status === "failed") {
      throw new AiApiError(
        "STRATEGY_SMOKE_TEST_FAILED",
        `策略未通过可运行性验证：${smoke.reason}。请让助手修正后重试。`,
        422,
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
      // 冒烟结论一并留痕。skipped 必须显式写出来，
      // 否则「未验证」在界面上看起来和「已通过」一样（INV-6）。
      conversionWarnings: [...draft.conversionWarnings, describeStrategySmokeVerdict(smoke)],
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
