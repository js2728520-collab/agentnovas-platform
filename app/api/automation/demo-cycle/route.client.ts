export async function POST() {
  return Response.json(
    { error: { code: "LEGACY_RUNTIME_RETIRED", message: "旧模拟 HTTP 运行入口已停用，请使用独立 Runtime Worker", details: {} } },
    { status: 410 },
  );
}
