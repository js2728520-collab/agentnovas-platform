export async function GET() {
  return Response.json({
    status: "available",
    mode: "shadow-paper-only",
    timestamp: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store, max-age=0" } });
}
