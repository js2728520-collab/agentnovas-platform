import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { requireCurrentSession } from "@/lib/session";
import {
  normalizeUserAppPreferencePatch,
  UserAppPreferenceValidationError,
  type UserAppPreference,
} from "@/lib/user-app-preference";
import { readUserAppPreference, writeUserAppPreference } from "@/lib/user-app-preference-service";

function validationError(error: UserAppPreferenceValidationError) {
  const messages: Record<string, string> = {
    PREFERENCE_BODY_INVALID: "偏好设置必须是对象",
    PREFERENCE_FIELD_INVALID: "偏好设置包含不支持的字段",
    PREFERENCE_LOCALE_INVALID: "当前应用不支持所选语言",
    PREFERENCE_THEME_MODE_INVALID: "主题模式无效",
    PREFERENCE_THEME_PALETTE_INVALID: "调色板无效",
    PREFERENCE_PATCH_EMPTY: "至少需要修改一项偏好",
  };
  return new ResearchApiError(error.code, messages[error.code] ?? "偏好设置无效", 422);
}
export async function GET(request: Request) {
  try {
    const current = await requireCurrentSession(request);
    const preference = await readUserAppPreference(
      await getPostgresPool(),
      current.session.tokenHash,
    );
    return Response.json({ preference }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
    const current = await requireCurrentSession(request);
    const body = await readResearchJson(request, 2_048);
    let patch;
    try {
      patch = normalizeUserAppPreferencePatch(current.session.appAudience, body);
    } catch (error) {
      if (error instanceof UserAppPreferenceValidationError) throw validationError(error);
      throw error;
    }
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const before = await readUserAppPreference(client, current.session.tokenHash);
      const next: UserAppPreference = {
        locale: patch.locale ?? before.locale,
        themeMode: patch.themeMode ?? before.themeMode,
        themePalette: patch.themePalette ?? before.themePalette,
      };
      const preference = await writeUserAppPreference(client, current.session.tokenHash, next);
      await client.query(`
        INSERT INTO audit_logs(
          id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at
        ) VALUES($1,$2,'account.preference_updated','user_app_preference',$3,$4::jsonb,$5::jsonb,now())
      `, [
        crypto.randomUUID(), current.user.id, `${current.user.id}:${current.session.appAudience}`,
        JSON.stringify({ locale: before.locale, themeMode: before.themeMode, themePalette: before.themePalette }),
        JSON.stringify({ locale: preference.locale, themeMode: preference.themeMode, themePalette: preference.themePalette }),
      ]);
      await client.query("COMMIT");
      return Response.json({ ok: true, preference }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
