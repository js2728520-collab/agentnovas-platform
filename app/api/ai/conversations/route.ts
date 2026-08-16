import { ensureD1Schema } from "@/lib/d1-migrations";
import { aiErrorResponse, readAiJson, requireAiCustomer } from "@/lib/ai-api";
import { createAiConversation, listAiConversations } from "@/lib/ai-conversations";

export async function GET(request: Request) {
  try {
    await ensureD1Schema();
    const user = await requireAiCustomer(request);
    return Response.json({ conversations: await listAiConversations(user.id) });
  } catch (error) {
    return aiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
    const user = await requireAiCustomer(request);
    const body = await readAiJson(request);
    const conversation = await createAiConversation(user.id, body);
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
