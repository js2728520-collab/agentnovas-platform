export async function POST() {
  return Response.json({
    error: {
      code: "LEGACY_LLM_CONFIG_RETIRED",
      message: "旧系统模型测试已退役，请在模型 Profile 中执行验证。",
    },
  }, { status: 503 });
}
