import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import {
  officialTradingHallStrategies,
  tradingHallAgentCatalog,
  tradingHallAgentKeyForRuntimeRole,
  tradingHallRoundCompletenessForRuntimeRoles,
  type TradingHallAgentKey,
  type OfficialTradingHallStrategy,
  type TradingHallDecisionEvent,
  type TradingHallExecutionMode,
  type TradingHallPayload,
} from "@/packages/contracts/src/trading-hall";

type DeploymentRow = {
  id: string;
  decision_round_id: string | null;
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
  paper_order_intent_count: number;
  paper_fill_receipt_count: number;
  latest_paper_intent_at: Date | null;
  latest_paper_fill_at: Date | null;
};

type RuntimeEventRow = {
  cycle_id: string;
  decision_round_id: string | null;
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

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function decisionStatus(row: Pick<
  DeploymentRow,
  "decision_json" | "mode" | "paper_fill_receipt_count" | "paper_order_intent_count"
>) {
  if (row.decision_json?.riskApproved === false) return "risk_rejected";
  if (row.paper_fill_receipt_count > 0) return "paper_filled";
  if (row.paper_order_intent_count > 0) {
    return row.mode === "paper" ? "approved_paper" : "approved_shadow";
  }
  const action = typeof row.decision_json?.action === "string"
    ? row.decision_json.action.trim().toLowerCase()
    : "";
  if (!action || action === "monitoring") return "monitoring";
  if (action === "hold") return "waiting";
  return action;
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
        -- 决策轮直接取共享表里该卡该品种的最新一轮，而不是经由客户自己的周期。
        -- 纯 hold 不为每个组合写周期行（ADR-0018 的已定决策），若还从周期取，
        -- 客户在 hold 的那根 K 线上会看到上一次有动作时的旧轮。
        round.id AS decision_round_id,
        COALESCE(round.candle_close_time, cycle.candle_close_time) AS candle_close_time,
        COALESCE(round.decision_json, cycle.decision_json) AS decision_json,
        COALESCE(round.trace_id, cycle.trace_id) AS trace_id,
        COALESCE((
          SELECT count(*)::int
          FROM official_paper_order_intents AS intent
          WHERE intent.runtime_cycle_id = cycle.id
        ), 0) AS paper_order_intent_count,
        COALESCE((
          SELECT count(*)::int
          FROM official_paper_fill_receipts AS receipt
          JOIN official_paper_order_intents AS intent ON intent.id = receipt.intent_id
          WHERE intent.runtime_cycle_id = cycle.id
        ), 0) AS paper_fill_receipt_count,
        (
          SELECT max(intent.created_at)
          FROM official_paper_order_intents AS intent
          WHERE intent.runtime_cycle_id = cycle.id
        ) AS latest_paper_intent_at,
        (
          SELECT max(receipt.filled_at)
          FROM official_paper_fill_receipts AS receipt
          JOIN official_paper_order_intents AS intent ON intent.id = receipt.intent_id
          WHERE intent.runtime_cycle_id = cycle.id
        ) AS latest_paper_fill_at,
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
      LEFT JOIN LATERAL (
        SELECT * FROM strategy_decision_rounds
        WHERE strategy_code = mapping.strategy_code AND symbol = mapping.symbol
        ORDER BY candle_close_time DESC LIMIT 1
      ) AS round ON true
      WHERE deployment.owner_user_id = $1
      ORDER BY mapping.strategy_code, deployment.updated_at DESC, deployment.id DESC
    `, [user.id]);

    // 七阶段结论从共享决策轮读（ADR-0018）：同一张卡在同一根 K 线上只判断一次。
    // 没有决策轮的行（过渡期历史数据、永续部署）仍按周期读。
    const cycleIds = deployments.rows.flatMap((row) => row.cycle_id ? [row.cycle_id] : []);
    const roundIds = [...new Set(deployments.rows.flatMap((row) => row.decision_round_id ? [row.decision_round_id] : []))];
    const eventResult = (cycleIds.length || roundIds.length) ? await pool.query<RuntimeEventRow>(`
      SELECT cycle_id, decision_round_id, sequence, role, conclusion, evidence_json,
             llm_used, explanation_status, explanation_json, created_at
      FROM strategy_runtime_events
      WHERE (decision_round_id = ANY($2::text[]))
         OR (decision_round_id IS NULL AND cycle_id = ANY($1::text[]))
      ORDER BY sequence
    `, [cycleIds, roundIds]) : { rows: [] as RuntimeEventRow[] };

    // 一个决策轮下有 N 个部署各写的事件（过渡期），按 role 去重后每轮只留一套。
    const eventsByRound = new Map<string, Map<string, RuntimeEventRow>>();
    const eventsByCycle = new Map<string, RuntimeEventRow[]>();
    for (const event of eventResult.rows) {
      if (event.decision_round_id) {
        const roles = eventsByRound.get(event.decision_round_id) ?? new Map<string, RuntimeEventRow>();
        const existing = roles.get(event.role);
        if (!existing || existing.created_at < event.created_at) roles.set(event.role, event);
        eventsByRound.set(event.decision_round_id, roles);
      } else {
        eventsByCycle.set(event.cycle_id, [...(eventsByCycle.get(event.cycle_id) || []), event]);
      }
    }

    const decisionRounds = deployments.rows.flatMap((deployment) => {
      const publicRoundId = deployment.cycle_id || deployment.decision_round_id;
      const code = strategyCode(deployment.strategy_code);
      if (!publicRoundId || !code) return [];
      const runtimeEvents = deployment.decision_round_id
        ? [...(eventsByRound.get(deployment.decision_round_id)?.values() ?? [])].sort((left, right) => left.sequence - right.sequence)
        : (deployment.cycle_id ? eventsByCycle.get(deployment.cycle_id) : undefined) || [];
      const events = runtimeEvents.flatMap((event) => {
        const view = eventView(event);
        return view ? [view] : [];
      });
      const official = officialTradingHallStrategies.find((strategy) => strategy.code === code)!;
      const status = decisionStatus(deployment);
      return [{
        decisionRoundId: publicRoundId,
        strategyCode: code,
        strategyName: official.name,
        strategyVersion: deployment.strategy_version_id,
        symbol: deployment.symbol,
        status,
        executionMode: deployment.mode,
        completeness: tradingHallRoundCompletenessForRuntimeRoles(runtimeEvents.map((event) => event.role)),
        traceId: deployment.trace_id,
        paperExecution: {
          orderIntentCount: deployment.paper_order_intent_count,
          fillReceiptCount: deployment.paper_fill_receipt_count,
          latestIntentAt: iso(deployment.latest_paper_intent_at),
          latestFillAt: iso(deployment.latest_paper_fill_at),
        },
        sharedDecisionRoundId: deployment.decision_round_id,
        updatedAt: iso(deployment.candle_close_time || deployment.updated_at),
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
        dataAvailable: Boolean(deployment?.cycle_id || deployment?.decision_round_id),
        openPositions: Number(deployment?.open_positions || 0),
        lastUpdatedAt: deployment
          ? iso(deployment.candle_close_time || deployment.updated_at)
          : null,
        latestDecisionRoundId: deployment
          ? (deployment.cycle_id || deployment.decision_round_id)
          : null,
        latestDecisionStatus: deployment ? decisionStatus(deployment) : null,
      };
    });

    const latestAgentByRole = new Map<TradingHallAgentKey, {
      event: TradingHallDecisionEvent;
      round: TradingHallPayload["decisionRounds"][number];
    }>();
    for (const round of decisionRounds) {
      for (const event of round.events) {
        if (event.role === "legacy_audit") continue;
        const current = latestAgentByRole.get(event.role);
        if (
          !current
          || current.event.createdAt < event.createdAt
          || (current.event.createdAt === event.createdAt && current.event.sequence < event.sequence)
        ) {
          latestAgentByRole.set(event.role, { event, round });
        }
      }
    }
    const legacyAuditRecords = eventResult.rows.filter((event) => event.role === "audit").length;
    const agents = tradingHallAgentCatalog.map((agent) => {
      const latest = latestAgentByRole.get(agent.key);
      return {
        ...agent,
        status: latest ? "reported" as const : agent.key === "final_decision" && legacyAuditRecords
          ? "legacy_gap" as const
          : "waiting" as const,
        latestConclusion: latest?.event.conclusion || null,
        latestUpdatedAt: latest?.event.createdAt || null,
        latestDecisionRoundId: latest?.round.decisionRoundId || null,
        latestSharedDecisionRoundId: latest?.round.sharedDecisionRoundId || null,
        latestStrategyName: latest?.round.strategyName || null,
        latestSymbol: latest?.round.symbol || null,
        latestDecisionStatus: latest?.round.status || null,
        latestCompleteness: latest?.round.completeness || null,
        latestExplanationStatus: latest?.event.explanationStatus || null,
        latestExplanation: latest?.event.explanation || null,
        latestEvidence: latest?.event.evidence || null,
        llmUsed: latest?.event.llmUsed ?? null,
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
