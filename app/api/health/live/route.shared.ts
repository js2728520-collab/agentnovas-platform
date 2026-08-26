export async function GET() {
  return Response.json({
    status: "alive",
    timestamp: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store, max-age=0" } });
}
