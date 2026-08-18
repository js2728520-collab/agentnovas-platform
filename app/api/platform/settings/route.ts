import { ensureD1Schema } from "@/lib/d1-migrations";
import { getAllPlatformSettings } from "@/lib/platform-settings";

export async function GET() {
  await ensureD1Schema();
  const settings = await getAllPlatformSettings();
  return Response.json({ system: settings.system, features: settings.features }, { headers: { "cache-control": "no-store" } });
}
