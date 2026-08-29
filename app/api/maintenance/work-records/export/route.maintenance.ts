import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import {
  parseMaintenanceWorkRecordExportInput,
  runMaintenanceWorkRecordExport,
} from "@/lib/maintenance-work-record-export";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, researchErrorResponse } from "@/lib/research-api";

const PERMISSION = "maint.work_records.export";

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, PERMISSION);
    const input = parseMaintenanceWorkRecordExportInput(await readResearchJson(request, 8_192));
    const command = await runMaintenanceWorkRecordExport(await getPostgresPool(), {
      ...input,
      actorUserId: user.id,
      idempotencyKey: idempotencyKey(request),
      ...maintenanceCorrelation(request),
    });
    return new Response(JSON.stringify(command.response), {
      status: command.responseStatus,
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="strategy-work-records-${input.from}-${input.to}.json"`,
        "idempotency-replayed": String(command.replayed),
        "x-content-type-options": "nosniff",
        "x-export-retention": "idempotency-record-only",
      },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
