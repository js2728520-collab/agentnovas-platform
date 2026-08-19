import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { getAllPlatformSettings, savePlatformSetting, type PlatformSettingSection } from "@/lib/platform-settings";
import { requireUser, responseError } from "@/lib/session";

const sections = new Set<PlatformSettingSection>(["system", "features", "billing", "integrations", "security"]);

export async function GET(request: Request) {
  try {
    await ensureD1Schema();
    await requireUser(request, ["hq_admin", "maintenance_admin"]);
    return Response.json({ settings: await getAllPlatformSettings() }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return responseError(error); }
}

export async function PUT(request: Request) {
  try {
    await ensureD1Schema();
    const actor = await requireUser(request, ["hq_admin", "maintenance_admin"]);
    const body = await request.json() as { section?: PlatformSettingSection; value?: unknown };
    if (!body.section || !sections.has(body.section)) return Response.json({ error: "无效的配置分区" }, { status: 400 });
    const before = (await getAllPlatformSettings())[body.section];
    const value = await savePlatformSetting(body.section, body.value, actor.id);
    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(), actorUserId: actor.id, action: `platform.settings.${body.section}.updated`, subjectType: "platform_settings", subjectId: body.section,
      beforeJson: JSON.stringify(before), afterJson: JSON.stringify(value), ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent"),
    });
    return Response.json({ ok: true, section: body.section, value });
  } catch (error) { return responseError(error); }
}
