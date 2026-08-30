import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type PaymentProviderTestKind = "provider_connectivity" | "callback_readiness";
export type PaymentProviderTestStatus = "passed" | "failed";

type PaymentProviderTestRow = {
  id: string;
  provider_config_id: string;
  test_kind: PaymentProviderTestKind;
  status: PaymentProviderTestStatus;
  configuration_version: string;
  error_code: string | null;
  actor_user_id: string;
  actor_email: string | null;
  reason: string;
  started_at: Date | string;
  completed_at: Date | string;
};

function iso(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function maskOperator(value: string | null) {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at <= 0) return "••••••••";
  return `${value[0]}•••@${value.slice(at + 1)}`;
}

function safeTestRun(row: PaymentProviderTestRow) {
  return {
    id: row.id,
    providerConfigId: row.provider_config_id,
    kind: row.test_kind,
    status: row.status,
    configurationVersion: row.configuration_version,
    errorCode: row.error_code,
    actor: maskOperator(row.actor_email),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

export async function recordPaymentProviderTestRun(queryable: Queryable, input: {
  providerConfigId: string;
  kind: PaymentProviderTestKind;
  status: PaymentProviderTestStatus;
  configurationVersion: string;
  errorCode?: string | null;
  actorUserId: string;
  reason: string;
  requestId?: string | null;
  traceId?: string | null;
  startedAt: Date;
  completedAt: Date;
}) {
  const errorCode = input.errorCode && /^[A-Z0-9_:-]{1,80}$/.test(input.errorCode)
    ? input.errorCode : input.status === "failed" ? "PAYMENT_PROVIDER_TEST_FAILED" : null;
  if (input.status === "passed" && errorCode) throw new Error("PAYMENT_PROVIDER_TEST_RESULT_INVALID");
  const result = await queryable.query<PaymentProviderTestRow>(`
    WITH inserted AS (
      INSERT INTO payment_provider_test_runs(
        id,provider_config_id,test_kind,status,configuration_version,error_code,
        actor_user_id,reason,request_id,trace_id,started_at,completed_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    )
    SELECT inserted.*,actor.email AS actor_email
      FROM inserted LEFT JOIN users AS actor ON actor.id=inserted.actor_user_id
  `, [
    crypto.randomUUID(), input.providerConfigId, input.kind, input.status,
    input.configurationVersion, errorCode, input.actorUserId, input.reason,
    input.requestId?.slice(0, 128) || null, input.traceId?.slice(0, 128) || null,
    input.startedAt, input.completedAt,
  ]);
  return safeTestRun(result.rows[0]);
}

export async function listPaymentProviderTestRuns(queryable: Queryable, limit = 30) {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await queryable.query<PaymentProviderTestRow>(`
    SELECT run.*,actor.email AS actor_email
      FROM payment_provider_test_runs AS run
      LEFT JOIN users AS actor ON actor.id=run.actor_user_id
     ORDER BY run.completed_at DESC,run.id DESC
     LIMIT $1
  `, [boundedLimit]);
  return result.rows.map(safeTestRun);
}
