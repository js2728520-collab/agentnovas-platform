import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { countPromptVersionTaskUsage } from "@/lib/prompt-skill-runtime";
import { researchErrorResponse } from "@/lib/research-api";

const VIEW_PERMISSION = "maint.configuration_versions.view";

/**
 * 某个 Prompt 配置版本上还固定着多少任务（PS-05）。
 *
 * 运维在激活或回滚前真正要知道的是「旧版还在跑吗」。这个接口只返回计数，不返回任何
 * 任务内容——它回答的是影响面，不是排查单个任务。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAccessPermission(request, VIEW_PERMISSION);
    const { id } = await params;
    const usage = await countPromptVersionTaskUsage(await getPostgresPool(), id);
    return Response.json(usage, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
