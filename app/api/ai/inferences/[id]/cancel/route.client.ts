import { requireAccessPermission } from "@/lib/access-control";
import { aiErrorResponse } from "@/lib/ai-api";
import { cancelClientAiInference } from "@/lib/client-ai-inference-service";
import { idempotencyKey } from "@/lib/commercial-request-validation";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "client.paper.view");
    idempotencyKey(request);
    const { id } = await params;
    const inference = await cancelClientAiInference(await getPostgresPool(), {
      userId: user.id,
      inferenceRequestId: id,
      requestId: request.headers.get("x-request-id")?.trim().slice(0, 160) || crypto.randomUUID(),
    });
    return Response.json({ inference }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
