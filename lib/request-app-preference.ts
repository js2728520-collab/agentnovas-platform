import type { AppAudience } from "./riverton-apps.ts";
import { cookieNameForAudience } from "./riverton-apps.ts";
import { getPostgresPool } from "./postgres.ts";
import { currentSession } from "./session.ts";
import { readUserAppPreference, type UserAppPreferencePayload } from "./user-app-preference-service.ts";

export async function requestAppPreference(
  requestHeaders: Headers,
  audience: AppAudience,
): Promise<UserAppPreferencePayload | null> {
  const cookies = requestHeaders.get("cookie") ?? "";
  if (!cookies.includes(`${cookieNameForAudience(audience)}=`)
    && !(audience === "client" && cookies.includes("an_session="))) return null;
  const forwarded = new Headers();
  requestHeaders.forEach((value, key) => forwarded.set(key, value));
  const host = requestHeaders.get("host") ?? "localhost";
  try {
    const current = await currentSession(new Request(`http://${host}/`, { headers: forwarded }));
    if (!current || current.session.appAudience !== audience) return null;
    return await readUserAppPreference(await getPostgresPool(), current.session.tokenHash);
  } catch {
    // 偏好不可用不能阻断登录页或工作区；客户端引导脚本会安全回退到本地/默认值。
    return null;
  }
}
