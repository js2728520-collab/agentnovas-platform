import { ensureD1Schema } from "@/lib/d1-migrations";
import { aiErrorResponse, readAiJson, requireAiCustomer } from "@/lib/ai-api";
import {
  getConversationMessages,
  getOwnedAiConversation,
  updateAiConversation,
} from "@/lib/ai-conversations";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureD1Schema();
    const user = await requireAiCustomer(request);
    const { id } = await params;
    const conversation = await getOwnedAiConversation(user.id, id);
    const messages = await getConversationMessages(user.id, id);
    return Response.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        purpose: conversation.purpose,
        status: conversation.status,
        lastMessageAt: conversation.lastMessageAt,
      },
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        generationMode: message.generationMode,
        providerName: message.providerName,
        createdAt: message.createdAt,
      })),
    });
  } catch (error) {
    return aiErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureD1Schema();
    const user = await requireAiCustomer(request);
    const { id } = await params;
    const body = await readAiJson(request);
    return Response.json({ conversation: await updateAiConversation(user.id, id, body) });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
