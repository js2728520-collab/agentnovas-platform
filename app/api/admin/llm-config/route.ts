function retiredResponse() {
  return Response.json({
    error: {
      code: "LEGACY_LLM_CONFIG_RETIRED",
      message: "旧系统模型配置已退役，请使用模型 Profile 与 Agent 绑定。",
    },
  }, { status: 503 });
}

export async function GET() { return retiredResponse(); }

export async function PUT() { return retiredResponse(); }
