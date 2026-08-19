import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.system_health.view");
    const pool = await getPostgresPool();
    const result = await pool.query<{
      id: string;
      provider: string;
      channel: string;
      network: string | null;
      status: string;
      confirmation_threshold: number | null;
      updated_at: Date;
      encrypted_secret_ref: string | null;
    }>(`
      SELECT id, provider, channel, network, status, confirmation_threshold, updated_at, encrypted_secret_ref
      FROM payment_provider_configs
      ORDER BY channel ASC, provider ASC, network ASC NULLS FIRST
    `);
    return Response.json({
      providers: result.rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        channel: row.channel,
        network: row.network,
        status: row.status,
        confirmationThreshold: row.confirmation_threshold,
        hasSecret: Boolean(row.encrypted_secret_ref),
        updatedAt: row.updated_at.toISOString(),
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

