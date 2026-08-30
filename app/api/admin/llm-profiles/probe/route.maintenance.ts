import { requireAccessPermission } from "@/lib/access-control";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { responseError } from "@/lib/session";
import { LLM_PROVIDER_PRESETS } from "@/lib/llm-provider-presets";

/** Legacy discovery facade. Provider secrets now enter only through the browser envelope + Broker flow. */

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.llm_profiles.manage");
    // 预设是填表模板，不是白名单：运维仍可填任何 OpenAI 兼容端点。
    return Response.json({ presets: LLM_PROVIDER_PRESETS });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAccessPermission(request, "maint.llm_profiles.manage");
    await readResearchJson(request, 4_096);
    throw new ResearchApiError(
      "MODEL_KEY_ENVELOPE_REQUIRED",
      "保存前明文密钥探测已停用；请在 AI 控制面创建配置、通过浏览器加密密钥，再由 AI Gateway 发起探测",
      422,
    );
  } catch (error) {
    return responseError(error);
  }
}
