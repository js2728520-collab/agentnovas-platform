// Deprecated after persistent server-owned conversations were introduced.
// Keeping an explicit response avoids silently accepting client-supplied chat
// history from older builds.
export async function POST() {
  return Response.json({
    error: {
      code: "ENDPOINT_RETIRED",
      message: "请使用持久化 AI 对话接口",
      details: [],
    },
  }, {
    status: 410,
    headers: { deprecation: "true" },
  });
}
