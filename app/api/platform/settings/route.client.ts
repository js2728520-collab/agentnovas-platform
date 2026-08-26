import { ensureDatabaseSchema } from "@/lib/database-schema";
import { publicPlatformSettings } from "@/lib/platform-settings";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    return Response.json(await publicPlatformSettings(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
