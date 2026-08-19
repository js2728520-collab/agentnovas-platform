import { ensureD1Schema } from "@/lib/d1-migrations";
import { testLlmConfig, type LlmConfigInput } from "@/lib/llm-config";
import { requireUser, responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
    await requireUser(request, ["hq_admin", "maintenance_admin"]);
    const input = await request.json() as LlmConfigInput;
    return Response.json(await testLlmConfig({ id: "system-default", input }));
  } catch (error) { return responseError(error); }
}
