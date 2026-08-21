import { ensureDatabaseSchema } from "@/lib/database-schema";
import { aiErrorResponse, readAiJson } from "@/lib/ai-api";
import { createAiConversation, listAiConversations } from "@/lib/ai-conversations";
import { requireAccessPermission } from "@/lib/access-control";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "client.paper.view");
    return Response.json({ conversations: await listAiConversations(user.id) });
  } catch (error) {
    return aiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "client.paper.view");
    const body = await readAiJson(request);
    const conversation = await createAiConversation(user.id, body);
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
