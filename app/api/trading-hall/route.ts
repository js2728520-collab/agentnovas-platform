import { getPostgresPool } from "@/lib/postgres";
import { requireUser, responseError } from "@/lib/session";

const strategyCodes = ["ai_conservative", "ai_balanced", "ai_aggressive"] as const;
const names: Record<string, string> = {
  ai_conservative: "AI 稳健型",
  ai_balanced: "AI 平衡型",
  ai_aggressive: "AI 激进型",
};
const roleNames: Record<string, string> = {
  market_data: "市场分析师",
  technical_analysis: "技术分析师",
  strategy_decision: "策略研究员",
  adversarial_review: "反方审查员",
  risk: "首席风控官",
  execution: "交易执行员",
  audit: "审计 Agent",
};

export async function GET(request: Request) {
  try {
    const user = await requireUser(request, ["customer"]);
    const pool = await getPostgresPool();
    const deployments = await pool.query<{
      id: string; strategy_code: string; symbol: string; mode: "shadow" | "paper";
      status: string; validation_label: string; unverified_warning: boolean;
      strategy_version_id: string; updated_at: Date; cycle_id: string | null;
      cycle_sequence: string | null; candle_close_time: Date | null;
      decision_json: Record<string, unknown> | null; trace_id: string | null;
      open_positions: string;
    }>(`
      SELECT DISTINCT ON (mapping.strategy_code)
        deployment.id, mapping.strategy_code, mapping.symbol,
        deployment.mode, deployment.status, deployment.validation_label,
        deployment.unverified_warning, deployment.strategy_version_id,
        deployment.updated_at, cycle.id AS cycle_id,
        cycle.sequence AS cycle_sequence, cycle.candle_close_time,
        cycle.decision_json, cycle.trace_id,
        (SELECT count(*)::text FROM strategy_paper_positions AS position
         WHERE position.deployment_id = deployment.id AND position.status = 'open') AS open_positions
      FROM strategy_deployments AS deployment
      JOIN platform_strategy_migration_map AS mapping
        ON mapping.strategy_id = deployment.strategy_id
       AND mapping.strategy_version_id = deployment.strategy_version_id
      LEFT JOIN LATERAL (
        SELECT * FROM strategy_runtime_cycles
        WHERE deployment_id = deployment.id
        ORDER BY sequence DESC LIMIT 1
      ) AS cycle ON true
      WHERE deployment.owner_user_id = $1
      ORDER BY mapping.strategy_code, deployment.updated_at DESC, deployment.id DESC
    `, [user.id]);
    const cycleIds = deployments.rows.flatMap(row => row.cycle_id ? [row.cycle_id] : []);
    const events = cycleIds.length ? await pool.query<{
      cycle_id: string; sequence: number; role: string; conclusion: string;
      evidence_json: Record<string, unknown>; duration_ms: number;
      llm_used: boolean; model_name: string | null;
      explanation_status: string; explanation_json: { summary?: string } | null;
      explanation_model_name: string | null; explanation_duration_ms: number | null;
      explanation_error_code: string | null; created_at: Date;
    }>(`
      SELECT cycle_id, sequence, role, conclusion, evidence_json,
             duration_ms, llm_used, model_name, explanation_status,
             explanation_json, explanation_model_name, explanation_duration_ms,
             explanation_error_code, created_at
      FROM strategy_runtime_events
      WHERE cycle_id = ANY($1::text[])
      ORDER BY created_at DESC, cycle_id, sequence
    `, [cycleIds]) : { rows: [] };
    const eventsByCycle = new Map<string, typeof events.rows>();
    for (const event of events.rows) {
      eventsByCycle.set(event.cycle_id, [...(eventsByCycle.get(event.cycle_id) || []), event]);
    }
    const strategies = strategyCodes.map(code => {
      const deployment = deployments.rows.find(row => row.strategy_code === code);
      return {
        code,
        name: names[code],
        status: deployment?.status || "idle",
        version: deployment?.strategy_version_id || null,
        exchange: null,
        environment: deployment?.mode || null,
        validationLabel: deployment?.validation_label || null,
        unverifiedWarning: deployment?.unverified_warning ?? true,
        lastUpdatedAt: deployment?.candle_close_time || deployment?.updated_at || null,
        openPositions: Number(deployment?.open_positions || 0),
        unrealizedReferenceUsdt: 0,
        latestDecision: deployment?.cycle_id ? {
          id: deployment.cycle_id,
          symbol: deployment.symbol,
          status: String(deployment.decision_json?.action || "hold"),
          riskApprovalId: deployment.decision_json?.riskApproved === true ? deployment.cycle_id : null,
          agentTaskId: deployment.trace_id,
          evidence: deployment.decision_json || {},
          sequence: Number(deployment.cycle_sequence || 0),
        } : null,
      };
    });
    const agentTalks = deployments.rows.flatMap(deployment =>
      (eventsByCycle.get(deployment.cycle_id || "") || []).map(event => ({
        agent: roleNames[event.role] || event.role,
        role: event.role,
        message: event.conclusion,
        evidence: event.evidence_json,
        strategyCode: deployment.strategy_code,
        strategyName: names[deployment.strategy_code],
        deploymentId: deployment.id,
        cycleId: event.cycle_id,
        sequence: event.sequence,
        durationMs: event.duration_ms,
        llmUsed: event.llm_used,
        modelName: event.model_name,
        explanationStatus: event.explanation_status,
        explanation: event.explanation_json,
        explanationModelName: event.explanation_model_name,
        explanationDurationMs: event.explanation_duration_ms,
        explanationErrorCode: event.explanation_error_code,
        updatedAt: event.created_at,
        source: "strategy_runtime_event",
      })),
    ).slice(0, 42);
    const activities = deployments.rows.flatMap(deployment => deployment.cycle_id ? [{
      id: deployment.cycle_id,
      deploymentId: deployment.id,
      strategyCode: deployment.strategy_code,
      strategyName: names[deployment.strategy_code],
      status: String(deployment.decision_json?.action || "hold"),
      symbol: deployment.symbol,
      updatedAt: deployment.candle_close_time,
      evidence: deployment.decision_json || {},
      traceId: deployment.trace_id,
      events: eventsByCycle.get(deployment.cycle_id) || [],
    }] : []);
    return Response.json({
      strategies,
      agentTalks,
      activities,
      runtime: { engine: "dsl-v3-unified", realOrderRoutingEnabled: false },
      generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return responseError(error);
  }
}
