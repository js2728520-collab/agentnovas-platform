import { requireAccessPermission } from "@/lib/access-control";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import {
  getSystemSettings,
  normalizeSystemSettings,
  normalizeTelegramSupportUrl,
} from "@/lib/platform-settings";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const PERMISSION = "maint.feature_flags.manage";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireAccessPermission(request, PERMISSION);
    return Response.json({ system: await getSystemSettings() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, PERMISSION);
    const body = await readResearchJson(request);
    const maintenanceReason = typeof body.maintenanceReason === "string" ? body.maintenanceReason.trim() : "";
    if (maintenanceReason.length < 3) throw new ResearchApiError("VALIDATION_ERROR", "必须填写设置变更原因（至少 3 个字符）", 422, { fields: ["maintenanceReason"] });
    if (maintenanceReason.length > 500) throw new ResearchApiError("VALIDATION_ERROR", "设置变更原因不能超过 500 个字符", 422, { fields: ["maintenanceReason"] });
    if (!body.system || typeof body.system !== "object" || Array.isArray(body.system)) {
      throw new ResearchApiError("VALIDATION_ERROR", "系统设置必须是对象", 422, { fields: ["system"] });
    }
    const rawSystem = body.system as Record<string, unknown>;
    const rawTelegram = typeof rawSystem.telegramSupportUrl === "string" ? rawSystem.telegramSupportUrl.trim() : "";
    if (rawTelegram && !normalizeTelegramSupportUrl(rawTelegram)) {
      throw new ResearchApiError("VALIDATION_ERROR", "Telegram 客服链接必须使用受支持域名的 HTTPS 地址", 422, { fields: ["telegramSupportUrl"] });
    }
    const next = normalizeSystemSettings(rawSystem);
    if (next.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.supportEmail)) {
      throw new ResearchApiError("VALIDATION_ERROR", "请输入有效的客服邮箱", 422, { fields: ["supportEmail"] });
    }
    const before = await getSystemSettings();
    const correlation = maintenanceCorrelation(request);
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO platform_settings (id, section, payload_json, updated_by_user_id, created_at, updated_at)
        VALUES ($1, 'system', $2::jsonb, $3, now(), now())
        ON CONFLICT (section) DO UPDATE SET
          payload_json = EXCLUDED.payload_json,
          updated_by_user_id = EXCLUDED.updated_by_user_id,
          updated_at = now()
      `, [crypto.randomUUID(), JSON.stringify(next), user.id]);
      await client.query(`
        INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, before_json, after_json, request_id, trace_id, created_at)
        VALUES ($1, $2, 'platform.settings.system.updated', 'platform_settings', 'system', $3, $4, $5, $6, now())
      `, [crypto.randomUUID(), user.id, JSON.stringify(before), JSON.stringify({ system: next, maintenanceReason }), correlation.requestId, correlation.traceId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return Response.json({ system: next, message: "平台公开设置已保存并记录审计" });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
