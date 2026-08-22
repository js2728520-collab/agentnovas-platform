import { getPostgresPool } from "@/lib/postgres";

export async function GET() {
  try {
    const pool = await getPostgresPool();
    await pool.query("SELECT 1");
    return Response.json({
      status: "ready",
      timestamp: new Date().toISOString(),
    }, { headers: { "cache-control": "no-store, max-age=0" } });
  } catch {
    return Response.json({
      status: "not_ready",
      timestamp: new Date().toISOString(),
    }, {
      status: 503,
      headers: { "cache-control": "no-store, max-age=0" },
    });
  }
}
