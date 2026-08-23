import { requireAccessPermission } from "@/lib/access-control";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { responseError } from "@/lib/session";
import { LLM_PROVIDER_PRESETS } from "@/lib/llm-provider-presets";
import { probeLlmProvider } from "@/lib/llm-model-catalog";

/**
 * 保存前探测供应商：测连通 + 拉模型列表。
 *
 * 补的是一个反向依赖：此前唯一的连通测试接口测的是**已绑定到生产角色**的 Profile，
 * 于是必须先把一个未经验证的配置绑到生产角色上，才能验证它。
 *
 * 这条接口在保存之前就能跑完「填地址和密钥 → 测试 → 拿模型列表」。
 *
 * **请求体里带明文 Key，但它不落库、不进日志、不进审计。** 审计只记录「谁探测了哪个
 * 地址、结果如何」——密钥本身在这条路径上是一次性的。
 */

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
    const { user } = await requireAccessPermission(request, "maint.llm_profiles.manage");
    const body = await readResearchJson(request, 4_096);
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const modelName = typeof body.modelName === "string" ? body.modelName.trim() : "";
    if (!baseUrl) throw new ResearchApiError("BASE_URL_REQUIRED", "请填写接口地址", 400);
    if (!apiKey) throw new ResearchApiError("API_KEY_REQUIRED", "请填写 API Key", 400);

    let result;
    try {
      result = await probeLlmProvider({
        baseUrl, apiKey, modelName: modelName || undefined,
      });
    } catch (error) {
      // 探测失败也留审计：反复失败的探测本身是一个信号（配错了，或在试别人的 Key）。
      await getDb().insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: user.id,
        action: "llm_profile.probe_failed",
        subjectType: "llm_profile",
        subjectId: new URL(baseUrl).host,
        afterJson: JSON.stringify({
          host: new URL(baseUrl).host,
          reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }),
      });
      throw new ResearchApiError(
        "LLM_PROBE_FAILED",
        error instanceof Error ? error.message : "无法连接到该模型服务",
        502,
      );
    }

    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "llm_profile.probed",
      subjectType: "llm_profile",
      subjectId: new URL(baseUrl).host,
      // 只记主机名与模型数量，不记完整地址、不记密钥。
      afterJson: JSON.stringify({
        host: new URL(baseUrl).host,
        modelCount: result.models?.length ?? 0,
        completionTested: result.completion !== null,
      }),
    });

    return Response.json({
      ok: true,
      latencyMs: result.latencyMs,
      models: result.models,
      modelsUnavailableReason: result.modelsUnavailableReason,
      completion: result.completion,
    });
  } catch (error) {
    return responseError(error);
  }
}
