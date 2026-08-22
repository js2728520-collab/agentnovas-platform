const retiredResponse = () => Response.json({
  error: {
    code: "LEGACY_RUNTIME_RETIRED",
    message: "旧平台策略 HTTP 运行入口已停用，请使用独立 Runtime Worker",
    details: { replacement: "strategy-runtime-worker", realOrderRoutingEnabled: false },
  },
}, { status: 410 });

export async function POST() {
  return retiredResponse();
}
