import { aiErrorResponse, readAiJson, requireAiCustomer } from "@/lib/ai-api";
import { generateAssistantReply } from "@/lib/ai-assistant";
import { serializeSseEvent, splitStreamingText } from "@/lib/ai-chat-protocol";
import {
  appendAssistantMessage,
  appendUserMessage,
  consumeAiRequestQuota,
  getConversationMessages,
  getOwnedAiConversation,
  recordAiMessageFailure,
} from "@/lib/ai-conversations";
import { buildAssistantContext } from "@/lib/ai-context";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { resolveLlmConfig } from "@/lib/llm-config";
import { normalizeAiMessage } from "@/lib/ai-safety";

const encoder = new TextEncoder();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const user = await requireAiCustomer(request);
    const { id } = await params;
    const body = await readAiJson(request);
    let content: string;
    try {
      content = normalizeAiMessage(body.message);
    } catch (error) {
      return Response.json({
        error: {
          code: "VALIDATION_ERROR",
          message: error instanceof Error ? error.message : "消息格式无效",
          details: [],
        },
      }, { status: 400 });
    }
    const conversation = await getOwnedAiConversation(user.id, id);
    await consumeAiRequestQuota(user.id, content.length);
    const savedUser = await appendUserMessage(user.id, conversation, content);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(serializeSseEvent(event, data)));
        };
        send("meta", {
          conversationId: id,
          title: savedUser.title,
          userMessage: savedUser.message,
        });
        try {
          const [history, config] = await Promise.all([
            getConversationMessages(user.id, id),
            resolveLlmConfig(user.id),
          ]);
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
          });
          const assistantMessage = await appendAssistantMessage({
            userId: user.id,
            conversationId: id,
            content: result.text,
            mode: result.mode,
            providerName: "provider" in result ? result.provider : undefined,
            model: "model" in result ? result.model : undefined,
            suggestedAction: result.suggestedAction,
          });
          for (const text of splitStreamingText(result.text)) send("delta", { text });
          send("done", {
            message: assistantMessage,
            mode: result.mode,
            suggestedAction: result.suggestedAction || null,
            disclaimer: "AI 内容仅用于信息与策略研究，不构成投资建议或收益承诺。",
          });
        } catch {
          await recordAiMessageFailure(user.id, id).catch(() => undefined);
          send("error", { code: "AI_REPLY_FAILED", message: "AI 回复暂时不可用，请稍后重试" });
        } finally {
          controller.close();
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
