import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireAccessPermission } from "@/lib/access-control";
import { testLlmConfig, type LlmConfigInput } from "@/lib/llm-config";
import { researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireAccessPermission(request, "maint.llm_profiles.manage");
    const input = await request.json() as LlmConfigInput;
    return Response.json(await testLlmConfig({ id: "system-default", input }));
  } catch (error) { return researchErrorResponse(error); }
}
