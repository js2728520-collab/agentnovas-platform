import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import {
  exportMaintenanceWorkRecords,
  maintenanceWorkRecordExportQueryHash,
  parseMaintenanceWorkRecordExportRequest,
} from "@/lib/maintenance-work-record-export";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, researchErrorResponse } from "@/lib/research-api";

const PERMISSION = "maint.work_records.export";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const access = await requireAccessPermission(request, PERMISSION);
    // 8 KiB：body 只有三个短字段，给足余量的同时不给超大 payload 留口子。
    const body = await readResearchJson(request, 8_192);
    const input = parseMaintenanceWorkRecordExportRequest(body);
    const correlation = maintenanceCorrelation(request);

    const command = await runMaintenanceIdempotentCommand(await getPostgresPool(), {
      operation: "maintenance.work_records.export",
      actorUserId: access.user.id,
      subjectType: "maintenance_work_record_export",
      subjectId: `${input.from}..${input.to}`,
      idempotencyKey: idempotencyKey(request),
      // 幂等绑定包含原因：换一个原因就是另一次导出，必须重新留审计。
      payload: { from: input.from, to: input.to, reason: input.reason },
      ...correlation,
    }, async (client) => {
      const result = await exportMaintenanceWorkRecords(client, input);
      // 审计只留查询摘要与条数，不留导出正文——正文是逐条客户决策记录。
      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id,trace_id,created_at)
        VALUES($1,$2,'maintenance.work_records.exported',$3,$4,$5,$6,$7,now())
      `, [
        crypto.randomUUID(),
        access.user.id,
        "maintenance_work_record_export",
        `${input.from}..${input.to}`,
        JSON.stringify({
          from: input.from,
          to: input.to,
          days: input.days,
          rowCount: result.rowCount,
          truncated: result.truncated,
          maxRows: result.maxRows,
          queryHash: maintenanceWorkRecordExportQueryHash(input),
          reason: input.reason,
        }),
        correlation.requestId,
        correlation.traceId,
      ]);
      return { terminalStatus: "succeeded" as const, responseStatus: 200, response: result };
    });

    // 服务端不落导出文件：结果只在这次响应里存在，不进磁盘也不进对象存储。
    return Response.json(command.response, {
      status: command.responseStatus,
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": `attachment; filename="work-records-${input.from}_${input.to}.json"`,
        "x-export-retention": "none",
      },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
