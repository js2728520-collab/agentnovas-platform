import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { responseError } from "@/lib/session";
import { collectPlatformReadiness } from "@/lib/platform-readiness";

/**
 * 开服就绪清单。**只读**——它只回答「还差什么」，不替你做任何配置。
 *
 * 这些配置项里有一半不该自动化：七项披露要双人审批、优盾凭证要人工填、初始管理员
 * 密码不能由脚本生成。自动化它们等于绕过刚建好的治理控制。
 *
 * 上线后它变成持续的健康检查：某天有人把披露下架，或某个 Agent 角色的模型被停用，
 * 清单会立刻变红。
 */
export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.system_health.view");
    const result = await collectPlatformReadiness(await getPostgresPool());
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}
