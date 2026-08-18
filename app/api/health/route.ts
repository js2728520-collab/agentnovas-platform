import { getPostgresPool } from "@/lib/postgres";
import { runtimeSetting } from "@/lib/runtime-setting";

export async function GET() {
  let database = "ok";
  let researchQueue = "ok";
  let runtimeQueue = "ok";
  let configuredResearchRoles = 0;
  let configuredRuntimeExplanationRoles = 0;
  let expiredRuntimeLeases = 0;
  let pendingRuntimeExplanations = 0;
  let failedRuntimeExplanations = 0;
  try {
    const pool = await getPostgresPool();
    const [roles, runtimeRoles, research, runtime, runtimeExplanations] = await Promise.all([
      pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM agent_role_bindings AS binding
        JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
        WHERE binding.enabled = true AND profile.enabled = true
          AND profile.current_revision_id IS NOT NULL
      `),
      pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM runtime_explanation_bindings AS binding
        JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
        WHERE binding.enabled = true AND profile.enabled = true
          AND profile.current_revision_id IS NOT NULL
      `),
      pool.query<{ failed: string }>(`
        SELECT count(*) FILTER (WHERE status = 'failed')::text AS failed
        FROM strategy_research_runs WHERE created_at >= now() - interval '24 hours'
      `),
      pool.query<{ expired: string; failed: string }>(`
        SELECT
          count(*) FILTER (WHERE status = 'active' AND lease_expires_at < now())::text AS expired,
          count(*) FILTER (WHERE status = 'failed')::text AS failed
        FROM strategy_deployments
      `),
      pool.query<{ pending: string; failed: string }>(`
        SELECT
          count(*) FILTER (WHERE status IN ('pending', 'running', 'retry_wait'))::text AS pending,
          count(*) FILTER (WHERE status = 'failed' AND updated_at >= now() - interval '24 hours')::text AS failed
        FROM strategy_runtime_explanation_jobs
      `),
    ]);
    configuredResearchRoles = Number(roles.rows[0]?.count || 0);
    configuredRuntimeExplanationRoles = Number(runtimeRoles.rows[0]?.count || 0);
    if (Number(research.rows[0]?.failed || 0) > 0) researchQueue = "recent_failures";
    expiredRuntimeLeases = Number(runtime.rows[0]?.expired || 0);
    pendingRuntimeExplanations = Number(runtimeExplanations.rows[0]?.pending || 0);
    failedRuntimeExplanations = Number(runtimeExplanations.rows[0]?.failed || 0);
    if (Number(runtime.rows[0]?.failed || 0) > 0 || expiredRuntimeLeases > 0) runtimeQueue = "attention_required";
  } catch {
    database = "missing";
    researchQueue = "unavailable";
    runtimeQueue = "unavailable";
  }
  const encryptionKey = Boolean(
    runtimeSetting("EXCHANGE_CREDENTIAL_ENCRYPTION_KEY")
      && runtimeSetting("EXCHANGE_CREDENTIAL_ENCRYPTION_KEY")!.length >= 32,
  );
  const llmEncryptionKey = Boolean(
    runtimeSetting("LLM_PROFILE_ENCRYPTION_KEY")
      && runtimeSetting("LLM_PROFILE_ENCRYPTION_KEY")!.length >= 32,
  );
  return Response.json({
    status: database === "ok" && encryptionKey && llmEncryptionKey ? "ready" : "degraded",
    mode: "shadow-paper-only",
    checks: {
      database,
      encryptionKey,
      llmEncryptionKey,
      configuredResearchRoles,
      configuredRuntimeExplanationRoles,
      researchQueue,
      runtimeQueue,
      expiredRuntimeLeases,
      pendingRuntimeExplanations,
      failedRuntimeExplanations,
      researchWorkerEnabled: runtimeSetting("STRATEGY_RESEARCH_ENABLED") === "true",
      runtimeWorkerEnabled: runtimeSetting("STRATEGY_RUNTIME_ENABLED") === "true",
      emergencyStop: runtimeSetting("PLATFORM_EMERGENCY_STOP") === "true",
      liveTradingEnabled: false,
      publicAutomationEndpoints: "retired",
    },
    timestamp: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store, max-age=0" } });
}
