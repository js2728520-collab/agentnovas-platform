export async function POST() {
  return Response.json({ error: "接口不存在" }, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}
