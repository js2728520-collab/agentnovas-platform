import type { Pool, PoolClient, QueryResult } from "pg";

import type { AppAudience } from "./riverton-apps.ts";
import type { UserAppPreference } from "./user-app-preference.ts";
import { ResearchApiError } from "./research-errors.ts";

type PreferenceRow = {
  user_id: string;
  app_audience: AppAudience;
  locale: UserAppPreference["locale"];
  theme_mode: UserAppPreference["themeMode"];
  theme_palette: UserAppPreference["themePalette"];
  updated_at: Date | string;
};

export type UserAppPreferencePayload = UserAppPreference & {
  audience: AppAudience;
  updatedAt: string;
};

function payload(row: PreferenceRow): UserAppPreferencePayload {
  return {
    audience: row.app_audience,
    locale: row.locale,
    themeMode: row.theme_mode,
    themePalette: row.theme_palette,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function readUserAppPreference(
  database: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  sessionTokenHash: string,
  now = new Date(),
): Promise<UserAppPreferencePayload> {
  const result = await database.query<PreferenceRow>(
    "SELECT * FROM user_app_preference_read($1,$2)",
    [sessionTokenHash, now],
  );
  if (!result.rows[0]) throw new ResearchApiError("AUTH_REQUIRED", "登录验证已失效，请重新登录", 401);
  return payload(result.rows[0]);
}

export async function writeUserAppPreference(
  database: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  sessionTokenHash: string,
  preference: UserAppPreference,
  now = new Date(),
): Promise<UserAppPreferencePayload> {
  let result: QueryResult<PreferenceRow>;
  try {
    result = await database.query<PreferenceRow>(
      "SELECT * FROM user_app_preference_upsert($1,$2,$3,$4,$5)",
      [sessionTokenHash, preference.locale, preference.themeMode, preference.themePalette, now],
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "28000") {
      throw new ResearchApiError("AUTH_REQUIRED", "登录验证已失效，请重新登录", 401);
    }
    throw error;
  }
  if (!result.rows[0]) throw new ResearchApiError("AUTH_REQUIRED", "登录验证已失效，请重新登录", 401);
  return payload(result.rows[0]);
}
