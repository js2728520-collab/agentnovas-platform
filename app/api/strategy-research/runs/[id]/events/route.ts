import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { getOwnedResearchRun, listResearchEvents } from "@/lib/postgres-research-queue";
import { requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const url = new URL(request.url);
    const querySequence = Number(url.searchParams.get("afterSequence") || 0);
    const headerSequence = Number(request.headers.get("last-event-id") || 0);
    const startSequence = Math.max(
      Number.isSafeInteger(querySequence) && querySequence >= 0 ? querySequence : 0,
      Number.isSafeInteger(headerSequence) && headerSequence >= 0 ? headerSequence : 0,
    );
    const pool = await getPostgresPool();
    const owned = await getOwnedResearchRun(pool, { runId: id, ownerUserId: user.id });
    if (!owned) throw new ResearchApiError("RUN_NOT_FOUND", "研发任务不存在", 404);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let afterSequence = startSequence;
        let heartbeatAt = Date.now();
        try {
          for (let poll = 0; poll < 55 && !request.signal.aborted; poll += 1) {
            const events = await listResearchEvents(pool, {
              runId: id,
              ownerUserId: user.id,
              afterSequence,
              limit: 100,
            });
            for (const event of events) {
              afterSequence = event.sequence;
              controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`));
            }
            const run = await getOwnedResearchRun(pool, { runId: id, ownerUserId: user.id });
            if (!run || terminalStatuses.has(run.status)) {
              controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ status: run?.status ?? "missing" })}\n\n`));
              break;
            }
            if (Date.now() - heartbeatAt >= 15_000) {
              controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
              heartbeatAt = Date.now();
            }
            await new Promise(resolve => setTimeout(resolve, 1_000));
          }
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
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
