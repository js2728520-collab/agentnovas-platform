/**
 * 供应商预设。
 *
 * **这不是白名单。** 它只是填表模板——选中后自动填入 base_url，运维仍可改成任何
 * 地址。平台对模型供应商始终是完全自定义的（`llm_profiles` 的 provider_name /
 * base_url / model_name 都是自由文本）。
 *
 * 预设存在的理由只有一个：不同供应商的路径差异很容易填错——`/v1` 要不要带、
 * `/chat/completions` 会不会被自动拼上。填错的表现是连通测试失败，而错误信息看不出
 * 是哪一段写错了。
 *
 * 注意与客户侧的边界区分：**客户不能自备模型或密钥**（BYOK 硬关闭，见
 * DEVELOPMENT_HANDOFF 的绊线说明）。本文件服务的是运维端，两者不冲突。
 */

export type LlmProviderPreset = {
  id: string;
  label: string;
  /** 空字符串表示「自定义」——不预填，由运维自己写。 */
  baseUrl: string;
  /** 给运维看的一句话，说明这个预设的特殊之处。 */
  note: string;
};

/**
 * 全部走 OpenAI 兼容协议，因此一套代码即可。
 *
 * Anthropic 原生协议不兼容，不在预设里——要用 Claude 通常经中转站（也是 OpenAI
 * 兼容），那种情况选「自定义」填中转地址即可。
 */
export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = Object.freeze([
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    note: "官方端点，需要可直连的网络环境。",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    note: "聚合多家模型，模型名形如 anthropic/claude-sonnet-4；一把 Key 可跨供应商。",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    note: "国内可直连。",
  },
  {
    id: "moonshot",
    label: "Moonshot 月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    note: "国内可直连。",
  },
  {
    id: "dashscope",
    label: "通义千问 DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    note: "必须用 compatible-mode 路径，原生路径不是 OpenAI 协议。",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    note: "路径不含 /v1，是 /api/paas/v4。",
  },
  {
    id: "custom",
    label: "自定义",
    baseUrl: "",
    note: "任何 OpenAI 兼容端点：中转站、自建 vLLM / Ollama、企业内网网关等。",
  },
]);

export function findLlmProviderPreset(id: string): LlmProviderPreset | null {
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}
