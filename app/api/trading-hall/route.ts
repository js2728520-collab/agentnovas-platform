import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import {
  officialTradingHallStrategies,
  tradingHallAgentCatalog,
  tradingHallAgentKeyForRuntimeRole,
  tradingHallRoundCompletenessForRuntimeRoles,
  type OfficialTradingHallStrategy,
  type TradingHallDecisionEvent,
  type TradingHallExecutionMode,
  type TradingHallPayload,
} from "@/packages/contracts/src/trading-hall";

type DeploymentRow = {
  id: string;
  strategy_code: string;
  symbol: string;
  mode: "shadow" | "paper";
  status: string;
  strategy_version_id: string;
  updated_at: Date;
  cycle_id: string | null;
  candle_close_time: Date | null;
  decision_json: Record<string, unknown> | null;
  trace_id: string | null;
  open_positions: string;
};

type RuntimeEventRow = {
  cycle_id: string;
  sequence: number;
  role: string;
  conclusion: string;
  evidence_json: Record<string, unknown>;
  llm_used: boolean;
  explanation_status: string;
  explanation_json: { summary?: string } | null;
  created_at: Date;
};

const strategyCodes = new Set(officialTradingHallStrategies.map((strategy) => strategy.code));

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicScalar(value: unknown) {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function pick(source: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = publicScalar(source[key]);
    return value === undefined ? [] : [[key, value]];
  }));
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 500))
    : [];
}

function publicEvidence(role: string, evidence: Record<string, unknown>) {
  switch (role) {
    case "market_data":
      return pick(evidence, ["valid", "candleCount", "gapsOrDuplicates", "marketState", "sampleSize", "returnPct", "averageRangePct", "candleCloseTime"]);
    case "technical_analysis":
      return pick(evidence, ["longEntry", "shortEntry", "dslExit", "close"]);
    case "strategy_decision":
      return pick(evidence, ["action", "reason", "strategyVersionId"]);
    case "adversarial_review":
      return { objections: stringList(evidence.objections) };
    case "risk":
      return {
        riskState: pick(asRecord(evidence.riskState), ["drawdownPct", "dailyLossPct", "consecutiveLosses", "halted"]),
        rejectionReasons: stringList(evidence.rejectionReasons),
      };
    case "decision":
      return {
        ...pick(evidence, ["action", "reason", "riskApproved"]),
        rejectionReasons: stringList(evidence.rejectionReasons),
      };
    case "execution": {
      const orderIntent = asRecord(evidence.orderIntent);
      return {
        executionMode: publicScalar(evidence.executionMode),
        orderIntent: Object.keys(orderIntent).length ? pick(orderIntent, [
          "mode",
          "action",
          "side",
          "executionTiming",
          "requestedPrice",
          "confirmedAtCandleCloseTime",
        ]) : null,
      };
    }
    case "audit":
      return { legacy: true };
    default:
      return {};
  }
}

function eventView(event: RuntimeEventRow): TradingHallDecisionEvent | null {
  const productRole = tradingHallAgentKeyForRuntimeRole(event.role);
  if (!productRole && event.role !== "audit") return null;
  const catalog = productRole
    ? tradingHallAgentCatalog.find((agent) => agent.key === productRole)
    : null;
  return {
    sequence: event.sequence,
    role: productRole || "legacy_audit",
    name: catalog?.name || "系统审计（历史）",
    outputName: catalog?.outputName || "旧周期审计记录",
    conclusion: event.conclusion.slice(0, 2000),
    evidence: publicEvidence(event.role, event.evidence_json),
    llmUsed: event.llm_used,
    explanationStatus: event.explanation_status.slice(0, 100),
    explanation: typeof event.explanation_json?.summary === "string"
      ? event.explanation_json.summary.slice(0, 2000)
      : null,
    createdAt: event.created_at.toISOString(),
  };
}

function executionMode(rows: DeploymentRow[]): TradingHallExecutionMode {
  const modes = new Set(rows.map((row) => row.mode));
  if (modes.size === 0) return "unavailable";
  if (modes.size > 1) return "mixed_simulation";
  return modes.has("paper") ? "paper" : "shadow";
}

function strategyCode(value: string): OfficialTradingHallStrategy["code"] | null {
  return strategyCodes.has(value as OfficialTradingHallStrategy["code"])
    ? value as OfficialTradingHallStrategy["code"]
    : null;
}

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.paper.view");
    const pool = await getPostgresPool();
    const deployments = await pool.query<DeploymentRow>(`
      SELECT DISTINCT ON (mapping.strategy_code)
        deployment.id, mapping.strategy_code, mapping.symbol,
        deployment.mode, deployment.status, deployment.strategy_version_id,
        deployment.updated_at, cycle.id AS cycle_id,
        cycle.candle_close_time, cycle.decision_json, cycle.trace_id,
        CASE WHEN deployment.execution_product = 'spot_usdt' THEN
          (SELECT count(*)::text FROM official_paper_positions AS position
           WHERE position.portfolio_id = deployment.paper_portfolio_id AND position.status = 'open')
        ELSE
          (SELECT count(*)::text FROM strategy_paper_positions AS position
           WHERE position.deployment_id = deployment.id AND position.status = 'open')
        END AS open_positions
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

    const cycleIds = deployments.rows.flatMap((row) => row.cycle_id ? [row.cycle_id] : []);
    const eventResult = cycleIds.length ? await pool.query<RuntimeEventRow>(`
      SELECT cycle_id, sequence, role, conclusion, evidence_json,
             llm_used, explanation_status, explanation_json, created_at
      FROM strategy_runtime_events
      WHERE cycle_id = ANY($1::text[])
      ORDER BY cycle_id, sequence
    `, [cycleIds]) : { rows: [] as RuntimeEventRow[] };
    const eventsByCycle = new Map<string, RuntimeEventRow[]>();
    for (const event of eventResult.rows) {
      eventsByCycle.set(event.cycle_id, [...(eventsByCycle.get(event.cycle_id) || []), event]);
    }

    const decisionRounds = deployments.rows.flatMap((deployment) => {
      const code = strategyCode(deployment.strategy_code);
      if (!deployment.cycle_id || !code) return [];
      const runtimeEvents = eventsByCycle.get(deployment.cycle_id) || [];
      const events = runtimeEvents.flatMap((event) => {
        const view = eventView(event);
        return view ? [view] : [];
      });
      const official = officialTradingHallStrategies.find((strategy) => strategy.code === code)!;
      return [{
        decisionRoundId: deployment.cycle_id,
        strategyCode: code,
        strategyName: official.name,
        strategyVersion: deployment.strategy_version_id,
        symbol: deployment.symbol,
        status: String(deployment.decision_json?.riskApproved === false
          ? "risk_rejected"
          : deployment.decision_json?.action || "monitoring"),
        executionMode: deployment.mode,
        completeness: tradingHallRoundCompletenessForRuntimeRoles(runtimeEvents.map((event) => event.role)),
        traceId: deployment.trace_id,
        updatedAt: (deployment.candle_close_time || deployment.updated_at)?.toISOString() || null,
        events,
      }];
    });
    decisionRounds.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));

    const strategies: TradingHallPayload["strategies"] = officialTradingHallStrategies.map((official) => {
      const deployment = deployments.rows.find((row) => row.strategy_code === official.code);
      return {
        ...official,
        status: deployment?.status || "not_deployed",
        version: deployment?.strategy_version_id || null,
        executionMode: deployment?.mode || "unavailable",
        dataAvailable: Boolean(deployment?.cycle_id),
        openPositions: Number(deployment?.open_positions || 0),
        lastUpdatedAt: deployment
          ? (deployment.candle_close_time || deployment.updated_at).toISOString()
          : null,
        latestDecisionRoundId: deployment?.cycle_id || null,
        latestDecisionStatus: deployment?.decision_json
          ? String(deployment.decision_json.riskApproved === false
            ? "risk_rejected"
            : deployment.decision_json.action || "monitoring")
          : null,
      };
    });

    const latestEventByRole = new Map<string, RuntimeEventRow>();
    for (const event of eventResult.rows) {
      const role = tradingHallAgentKeyForRuntimeRole(event.role);
      if (!role) continue;
      const current = latestEventByRole.get(role);
      if (!current || current.created_at < event.created_at) latestEventByRole.set(role, event);
    }
    const legacyAuditRecords = eventResult.rows.filter((event) => event.role === "audit").length;
    const agents = tradingHallAgentCatalog.map((agent) => {
      const event = latestEventByRole.get(agent.key);
      return {
        ...agent,
        status: event ? "reported" as const : agent.key === "final_decision" && legacyAuditRecords
          ? "legacy_gap" as const
          : "waiting" as const,
        latestConclusion: event?.conclusion || null,
        latestUpdatedAt: event?.created_at.toISOString() || null,
      };
    });
    const currentExecutionMode = executionMode(deployments.rows);
    const productBoundary = {
      targetMarket: "spot_usdt" as const,
      symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const,
      leverageEnabled: false as const,
      shortSellingEnabled: false as const,
      realOrderRoutingEnabled: false as const,
      localExchangeExecutionEnabled: false as const,
      currentExecutionMode,
      alignmentStatus: "simulation_only" as const,
    };
    const payload: TradingHallPayload = {
      productBoundary,
      strategies,
      agents,
      decisionRounds,
      legacyAuditRecords,
      generatedAt: new Date().toISOString(),
    };
    return Response.json(payload, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
