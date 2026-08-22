import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { platformSettings } from "@/db/schema";
import {
  defaultSystemSettings,
  normalizeSystemSettings,
  normalizeTelegramSupportUrl,
  type PublicPlatformSettings,
  type SystemSettings,
} from "@/lib/platform-settings-contract";

export { defaultSystemSettings, normalizeSystemSettings, normalizeTelegramSupportUrl };
export type { PublicPlatformSettings, SystemSettings };

function parsePayload(payload: unknown) {
  try {
    return normalizeSystemSettings(typeof payload === "string" ? JSON.parse(payload || "{}") : payload);
  } catch {
    return { ...defaultSystemSettings };
  }
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const row = (await getDb().select({ payloadJson: platformSettings.payloadJson })
    .from(platformSettings)
    .where(eq(platformSettings.section, "system"))
    .limit(1))[0];
  return row ? parsePayload(row.payloadJson) : { ...defaultSystemSettings };
}

export async function publicPlatformSettings(): Promise<PublicPlatformSettings> {
  return { system: await getSystemSettings() };
}
