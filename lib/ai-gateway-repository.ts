import type {
  AiRoleKey,
  BindingCandidate,
  GatewayInvocationInput,
  GatewayInvocationResult,
  IdempotentInvocationRepository,
  UsageEvent,
} from "@agentnovas/ai-control-plane";
import type { Pool, QueryResultRow } from "pg";

const rawRoles = {
  "research.requirements": "requirements",
  "research.market_regime": "market_regime",
  "research.proposal_a": "proposal_a",
  "research.proposal_b": "proposal_b",
  "research.adversarial_review": "adversarial_review",
  "research.risk_review": "risk_review",
  "research.report": "report",
  "runtime.market_summary": "market_summary",
  "runtime.adversarial_explanation": "adversarial_explanation",
  "runtime.risk_explanation": "risk_explanation",
  "client.assistant_message": "assistant_message",
  "client.strategy_generation": "strategy_generation",
} as const satisfies Record<AiRoleKey,string>;

function consumer(roleKey: AiRoleKey, trafficKind: UsageEvent["trafficKind"]) {
  if (trafficKind === "probe") return "probe";
  if (roleKey.startsWith("research.")) return "research";
  if (roleKey.startsWith("runtime.")) return "runtime_explanation";
  return "client_ai";
}

type InvocationRow = QueryResultRow & {
  invocation_id: string;
  request_hash: string;
  status: "requested" | "processing" | "succeeded" | "failed" | "cancelled";
  binding_policy_revision_id: string | null;
  selected_deployment_revision_id: string | null;
  selected_connection_revision_id: string | null;
  response_content: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cached_input_tokens: string | null;
  reasoning_tokens: string | null;
  attempt_count: number;
  error_class: string | null;
  fallback_trace_json: unknown;
};

function exactToken(value: string | null) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function createPostgresInvocationRepository(pool: Pool): IdempotentInvocationRepository {
  return {
    async begin(input: GatewayInvocationInput) {
      const role = rawRoles[input.roleKey];
      const inserted = await pool.query(`
        INSERT INTO ai_invocation_receipts(
          invocation_id,request_hash,binding_policy_revision_id,role,operation,traffic_kind,status
        )
        SELECT $1,$2,policy.current_revision_id,$3,$4,$5,'processing'
        FROM (SELECT 1) AS singleton
        LEFT JOIN ai_binding_policies AS policy ON policy.role=$3
        ON CONFLICT(invocation_id) DO NOTHING
      `,[input.invocationId,input.requestHash,role,input.operation,input.trafficKind]);
      if (inserted.rowCount === 1) return { kind: "claimed" as const };
      const existing = (await pool.query<InvocationRow>(`
        SELECT invocation_id,request_hash,status,binding_policy_revision_id,
          selected_deployment_revision_id,selected_connection_revision_id,response_content,
          input_tokens::text,output_tokens::text,cached_input_tokens::text,reasoning_tokens::text,
          attempt_count,error_class,fallback_trace_json
        FROM ai_invocation_receipts WHERE invocation_id=$1
      `,[input.invocationId])).rows[0];
      if (!existing || existing.request_hash !== input.requestHash) return { kind: "conflict" as const };
      if (!new Set(["succeeded","failed","cancelled"]).has(existing.status)) return { kind: "in_progress" as const };
      const terminalStatus = existing.status === "succeeded"
        ? "succeeded" as const
        : existing.status === "failed"
          ? "failed" as const
          : "cancelled" as const;
      const trace = Array.isArray(existing.fallback_trace_json) ? existing.fallback_trace_json : [];
      const selection = trace.find(value => value && typeof value === "object" && "selected" in value);
      return {
        kind: "replay" as const,
        result: {
          content: existing.response_content ?? "",
          receipt: {
            invocationId: existing.invocation_id,
            requestHash: existing.request_hash,
            status: terminalStatus,
            selectedCandidate: selection && typeof selection === "object" && "selected" in selection
              ? selection.selected as GatewayInvocationResult["receipt"]["selectedCandidate"]
              : null,
            attemptCount: existing.attempt_count,
            usage: terminalStatus === "succeeded" ? {
              inputTokens: exactToken(existing.input_tokens),
              outputTokens: exactToken(existing.output_tokens),
              ...(exactToken(existing.cached_input_tokens) > 0
                ? { cachedInputTokens: exactToken(existing.cached_input_tokens) }
                : {}),
              ...(exactToken(existing.reasoning_tokens) > 0
                ? { reasoningTokens: exactToken(existing.reasoning_tokens) }
                : {}),
            } : null,
            ...(existing.error_class ? { errorCode: existing.error_class as NonNullable<GatewayInvocationResult["receipt"]["errorCode"]> } : {}),
          },
        },
      };
    },
    async complete(result: GatewayInvocationResult) {
      const selection = result.receipt.selectedCandidate;
      await pool.query(`
        UPDATE ai_invocation_receipts SET
          binding_policy_revision_id=COALESCE($3,binding_policy_revision_id),
          selected_deployment_revision_id=$4,
          selected_connection_revision_id=$5,
          status=$6,
          fallback_trace_json=$7::jsonb,
          input_tokens=$8,output_tokens=$9,cached_input_tokens=$10,reasoning_tokens=$11,
          response_content=$12,attempt_count=$13,error_class=$14,
          completed_at=now(),updated_at=now()
        WHERE invocation_id=$1 AND request_hash=$2 AND status='processing'
      `,[
        result.receipt.invocationId,result.receipt.requestHash,selection?.policyRevisionId ?? null,
        selection?.deploymentRevisionId ?? null,selection?.connectionRevisionId ?? null,
        result.receipt.status,JSON.stringify(selection ? [{ selected: selection }] : []),
        result.receipt.usage?.inputTokens ?? null,result.receipt.usage?.outputTokens ?? null,
        result.receipt.usage?.cachedInputTokens ?? null,result.receipt.usage?.reasoningTokens ?? null,
        result.content,result.receipt.attemptCount,result.receipt.errorCode ?? null,
      ]);
    },
  };
}

export async function resolvePostgresBindingCandidates(pool: Pool, roleKey: AiRoleKey): Promise<BindingCandidate[]> {
  const result = await pool.query<BindingCandidate & QueryResultRow>(`
    SELECT
      target.target_rank AS "fallbackRank",
      policy_revision.id AS "policyRevisionId",
      deployment.id AS "deploymentId",
      deployment_revision.id AS "deploymentRevisionId",
      connection.id AS "connectionId",
      connection_revision.id AS "connectionRevisionId",
      connection_revision.secret_ref AS "secretRef"
    FROM ai_binding_policies AS policy
    JOIN ai_binding_policy_revisions AS policy_revision ON policy_revision.id=policy.current_revision_id
    JOIN ai_binding_targets AS target ON target.binding_policy_revision_id=policy_revision.id
    JOIN ai_deployment_revisions AS deployment_revision ON deployment_revision.id=target.deployment_revision_id
    JOIN ai_model_deployments AS deployment ON deployment.id=deployment_revision.deployment_id
    JOIN ai_connection_revisions AS connection_revision ON connection_revision.id=deployment_revision.connection_revision_id
    JOIN ai_provider_connections AS connection ON connection.id=connection_revision.connection_id
    WHERE policy.role=$1 AND policy.enabled AND deployment.enabled AND connection.enabled
      AND connection_revision.secret_ref IS NOT NULL
      AND EXISTS(
        SELECT 1 FROM ai_probe_receipts AS probe
        WHERE probe.deployment_revision_id=deployment_revision.id
          AND probe.config_fingerprint=deployment_revision.config_fingerprint
          AND probe.status='succeeded'
      )
    ORDER BY target.target_rank
  `,[rawRoles[roleKey]]);
  return result.rows;
}

export async function readPostgresCandidateConfiguration(pool: Pool, candidate: BindingCandidate) {
  return (await pool.query<{
    endpoint: string;
    model_id: string;
    max_output_tokens: number | null;
    supports_streaming: boolean;
  }>(`
    SELECT connection.endpoint,deployment.model_id,deployment.max_output_tokens,deployment.supports_streaming
    FROM ai_deployment_revisions AS deployment
    JOIN ai_connection_revisions AS connection ON connection.id=deployment.connection_revision_id
    WHERE deployment.id=$1 AND connection.id=$2
  `,[candidate.deploymentRevisionId,candidate.connectionRevisionId])).rows[0] ?? null;
}

export function createPostgresUsageSink(pool: Pool) {
  return {
    async append(event: UsageEvent) {
      await pool.query(`
        INSERT INTO ai_usage_events(
          id,invocation_id,event_sequence,event_kind,consumer,role,deployment_revision_id,
          connection_revision_id,fallback_rank,input_tokens,output_tokens,cached_input_tokens,
          reasoning_tokens,queue_latency_ms,provider_latency_ms,total_latency_ms,
          provider_cost_amount,provider_cost_currency,platform_settled_credits,pricing_state,error_class,occurred_at
        )
        SELECT $1,$2,COALESCE(MAX(existing.event_sequence),0)+1,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17,$18,$19,$20,$21
        FROM ai_usage_events AS existing WHERE existing.invocation_id=$2
      `,[
        event.id,event.invocationId,event.status,consumer(event.roleKey,event.trafficKind),rawRoles[event.roleKey],
        event.deploymentRevisionId,event.connectionRevisionId,event.fallbackRank,
        event.usage?.inputTokens ?? 0,event.usage?.outputTokens ?? 0,event.usage?.cachedInputTokens ?? 0,
        event.usage?.reasoningTokens ?? 0,event.queueLatencyMs,event.providerLatencyMs,event.totalLatencyMs,
        event.providerCost?.amount ?? null,event.providerCost?.currency ?? null,event.settledCredits,
        event.pricingState,event.errorCode ?? null,event.createdAt,
      ]);
    },
  };
}
