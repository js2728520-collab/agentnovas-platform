import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type { ConfigurationVersion, ConfigurationVersionsPayload } from "../packages/contracts/src/versioned-configuration.ts";
import { encodeCommercialCursor, type CommercialCursor } from "./commercial-api-support.ts";
import {
  normalizeRegisteredConfigurationFamilyTestRequest,
  runRegisteredConfigurationFamilyTest,
} from "./configuration-family-registry.ts";
import {
  normalizeConfigurationActivation,
  normalizeConfigurationApproval,
  normalizeConfigurationDraft,
  normalizeConfigurationSchedule,
  normalizeConfigurationTest,
  type ConfigurationActivationAction,
  type ConfigurationApprovalDecision,
  type ConfigurationAudience,
  type ConfigurationKind,
  type ConfigurationTestResult,
  type NormalizedConfigurationTest,
} from "./versioned-configuration-domain.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type VersionRow = {
  id: string;
  kind: ConfigurationKind;
  configuration_key: string;
  audience: ConfigurationAudience;
  version_number: number;
  schema_version: number;
  payload_json: Record<string, unknown>;
  payload_sha256: string;
  reason: string;
  created_by_user_id: string;
  idempotency_key: string;
  request_id: string;
  created_at: Date | string;
};

type TestRow = {
  id: string;
  sequence_no: string;
  configuration_version_id: string;
  result: ConfigurationTestResult;
  evidence_sha256: string;
  tested_by_user_id: string;
  reason: string;
  idempotency_key: string;
  request_id: string;
  created_at: Date | string;
};

type ApprovalRow = {
  id: string;
  configuration_version_id: string;
  decision: ConfigurationApprovalDecision;
  reviewer_user_id: string;
  reason: string;
  idempotency_key: string;
  request_id: string;
  created_at: Date | string;
};

type ScheduleRow = {
  id: string;
  configuration_version_id: string;
  scheduled_for: Date | string;
  scheduled_by_user_id: string;
  reason: string;
  idempotency_key: string;
  request_id: string;
  created_at: Date | string;
};

type ActivationRow = {
  id: string;
  sequence_no: string;
  configuration_version_id: string;
  previous_configuration_version_id: string | null;
  action: ConfigurationActivationAction;
  actor_user_id: string | null;
  actor_kind: "user" | "worker";
  actor_identity: string | null;
  reason: string;
  idempotency_key: string;
  request_id: string;
  created_at: Date | string;
};

type CurrentActivationRow = ActivationRow & Pick<VersionRow, "kind" | "configuration_key" | "audience">;

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

function commandIdentity(value: string) {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 160) {
    throw new ResearchApiError("CONFIGURATION_IDEMPOTENCY_KEY_INVALID", "幂等键需要 8–160 个字符", 422);
  }
  return normalized;
}

function requestIdentity(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new ResearchApiError("CONFIGURATION_REQUEST_ID_INVALID", "requestId 无效", 422);
  return normalized;
}

function streamKey(row: Pick<VersionRow, "kind" | "configuration_key" | "audience">) {
  return `${row.kind}\u0000${row.configuration_key}\u0000${row.audience}`;
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function projectTest(row: TestRow) {
  return { id: row.id, result: row.result, evidenceSha256: row.evidence_sha256, testedByUserId: row.tested_by_user_id, reason: row.reason, createdAt: iso(row.created_at) };
}

function projectApproval(row: ApprovalRow) {
  return { id: row.id, decision: row.decision, reviewerUserId: row.reviewer_user_id, reason: row.reason, createdAt: iso(row.created_at) };
}

function projectSchedule(row: ScheduleRow) {
  return { id: row.id, scheduledFor: iso(row.scheduled_for), scheduledByUserId: row.scheduled_by_user_id, reason: row.reason, createdAt: iso(row.created_at) };
}

function projectActivation(row: ActivationRow) {
  return {
    id: row.id,
    action: row.action,
    previousConfigurationVersionId: row.previous_configuration_version_id,
    actorUserId: row.actor_user_id,
    actorKind: row.actor_kind,
    actorIdentity: row.actor_identity,
    reason: row.reason,
    createdAt: iso(row.created_at),
  };
}

function projectVersion(
  row: VersionRow,
  tests: TestRow[],
  approval: ApprovalRow | undefined,
  schedule: ScheduleRow | undefined,
  activations: ActivationRow[],
  currentByStream: Map<string, CurrentActivationRow>,
): ConfigurationVersion {
  const latestTest = tests[0];
  const current = currentByStream.get(streamKey(row));
  const isCurrent = current?.configuration_version_id === row.id;
  const status = isCurrent ? current.action === "rollback" ? "rolled_back" : "active"
    : activations.length ? "superseded"
      : approval?.decision === "reject" ? "rejected"
        : approval?.decision === "approve" && schedule ? "scheduled"
          : approval?.decision === "approve" ? "approved"
            : latestTest?.result === "passed" ? "tested"
              : latestTest?.result === "failed" ? "test_failed"
                : "draft";
  return {
    id: row.id,
    kind: row.kind,
    key: row.configuration_key,
    audience: row.audience,
    versionNumber: row.version_number,
    schemaVersion: row.schema_version,
    payload: row.payload_json,
    payloadSha256: row.payload_sha256,
    createdByUserId: row.created_by_user_id,
    reason: row.reason,
    createdAt: iso(row.created_at),
    status,
    isCurrent,
    latestTest: latestTest ? projectTest(latestTest) : null,
    approval: approval ? projectApproval(approval) : null,
    schedule: schedule ? projectSchedule(schedule) : null,
    activations: activations.map(projectActivation),
  };
}

async function currentActivations(queryable: Queryable) {
  const result = await queryable.query<CurrentActivationRow>(`
    SELECT DISTINCT ON (version.kind,version.configuration_key,version.audience)
           activation.*,version.kind,version.configuration_key,version.audience
      FROM configuration_activations AS activation
      JOIN configuration_versions AS version ON version.id=activation.configuration_version_id
     ORDER BY version.kind,version.configuration_key,version.audience,activation.sequence_no DESC
  `);
  return new Map(result.rows.map((row) => [streamKey(row), row]));
}

async function readRows(queryable: Queryable, input: { limit: number; cursor: CommercialCursor | null; id?: string }) {
  const values: unknown[] = [];
  const where: string[] = [];
  if (input.id) {
    values.push(input.id);
    where.push(`id=$${values.length}`);
  }
  if (input.cursor) {
    values.push(input.cursor.createdAt, input.cursor.id);
    where.push(`(created_at,id) < ($${values.length - 1}::timestamptz,$${values.length})`);
  }
  values.push(input.limit);
  const versions = await queryable.query<VersionRow>(`
    SELECT * FROM configuration_versions
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC,id DESC
     LIMIT $${values.length}
  `, values);
  const ids = versions.rows.map((row) => row.id);
  if (!ids.length) return { versions: versions.rows, tests: [] as TestRow[], approvals: [] as ApprovalRow[], schedules: [] as ScheduleRow[], activations: [] as ActivationRow[] };
  // Queryable may be a transaction-bound PoolClient. pg does not support
  // concurrent client.query calls on one client, so keep these reads ordered.
  const tests = await queryable.query<TestRow>(`SELECT * FROM configuration_test_results WHERE configuration_version_id=ANY($1::text[]) ORDER BY sequence_no DESC`, [ids]);
  const approvals = await queryable.query<ApprovalRow>(`SELECT * FROM configuration_approvals WHERE configuration_version_id=ANY($1::text[])`, [ids]);
  const schedules = await queryable.query<ScheduleRow>(`SELECT * FROM configuration_schedules WHERE configuration_version_id=ANY($1::text[])`, [ids]);
  const activations = await queryable.query<ActivationRow>(`SELECT * FROM configuration_activations WHERE configuration_version_id=ANY($1::text[]) ORDER BY sequence_no DESC`, [ids]);
  return { versions: versions.rows, tests: tests.rows, approvals: approvals.rows, schedules: schedules.rows, activations: activations.rows };
}

async function readVersionById(queryable: Queryable, id: string) {
  const records = await readRows(queryable, { limit: 1, cursor: null, id });
  const row = records.versions[0];
  if (!row) throw new ResearchApiError("CONFIGURATION_VERSION_NOT_FOUND", "配置版本不存在", 404);
  return projectVersion(
    row,
    records.tests.filter((item) => item.configuration_version_id === row.id),
    records.approvals.find((item) => item.configuration_version_id === row.id),
    records.schedules.find((item) => item.configuration_version_id === row.id),
    records.activations.filter((item) => item.configuration_version_id === row.id),
    await currentActivations(queryable),
  );
}

export async function readConfigurationVersions(queryable: Queryable, input: { limit: number; cursor: CommercialCursor | null }): Promise<ConfigurationVersionsPayload> {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
  const records = await readRows(queryable, { limit: limit + 1, cursor: input.cursor });
  const visible = records.versions.slice(0, limit);
  const current = await currentActivations(queryable);
  const last = visible.at(-1);
  return {
    versions: visible.map((row) => projectVersion(
      row,
      records.tests.filter((item) => item.configuration_version_id === row.id),
      records.approvals.find((item) => item.configuration_version_id === row.id),
      records.schedules.find((item) => item.configuration_version_id === row.id),
      records.activations.filter((item) => item.configuration_version_id === row.id),
      current,
    )),
    nextCursor: records.versions.length > limit && last ? encodeCommercialCursor({ createdAt: iso(last.created_at), id: last.id }) : null,
  };
}

function sameDraft(row: VersionRow, draft: ReturnType<typeof normalizeConfigurationDraft>) {
  return row.kind === draft.kind && row.configuration_key === draft.key && row.audience === draft.audience
    && row.schema_version === draft.schemaVersion && row.payload_sha256 === draft.payloadSha256 && row.reason === draft.reason;
}

export async function createConfigurationVersion(pool: Pool, input: { actorUserId: string; idempotencyKey: string; requestId: string; version: unknown }) {
  const draft = normalizeConfigurationDraft(input.version);
  const key = commandIdentity(input.idempotencyKey);
  const requestId = requestIdentity(input.requestId);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration-create:' || $1 || ':' || $2,0))", [input.actorUserId, key]);
    const replay = await client.query<VersionRow>(`SELECT * FROM configuration_versions WHERE created_by_user_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.actorUserId, key]);
    if (replay.rows[0]) {
      if (!sameDraft(replay.rows[0], draft)) throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一个配置草稿", 409);
      return readVersionById(client, replay.rows[0].id);
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration-stream:' || $1 || ':' || $2 || ':' || $3,0))", [draft.kind, draft.key, draft.audience]);
    const sequence = await client.query<{ next_version: number }>(`
      SELECT COALESCE(MAX(version_number),0)::int + 1 AS next_version
        FROM configuration_versions WHERE kind=$1 AND configuration_key=$2 AND audience=$3
    `, [draft.kind, draft.key, draft.audience]);
    const id = randomUUID();
    await client.query(`
      INSERT INTO configuration_versions(
        id,kind,configuration_key,audience,version_number,schema_version,payload_json,payload_sha256,
        reason,created_by_user_id,idempotency_key,request_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
    `, [id,draft.kind,draft.key,draft.audience,sequence.rows[0].next_version,draft.schemaVersion,draft.payloadCanonical,draft.payloadSha256,draft.reason,input.actorUserId,key,requestId]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
      VALUES($1,$2,'configuration.version.created','configuration_version',$3,$4,$5)
    `, [randomUUID(),input.actorUserId,id,JSON.stringify({ kind: draft.kind, key: draft.key, audience: draft.audience, versionNumber: sequence.rows[0].next_version, schemaVersion: draft.schemaVersion, payloadSha256: draft.payloadSha256, reason: draft.reason }),requestId]);
    return readVersionById(client, id);
  });
}

type ConfigurationTestFact = NormalizedConfigurationTest & { testerId?: string };

function configurationTestFact(row: VersionRow, input: unknown): ConfigurationTestFact {
  if (row.kind !== "feature_flag") return normalizeConfigurationTest(input);
  const request = normalizeRegisteredConfigurationFamilyTestRequest(input);
  const automated = runRegisteredConfigurationFamilyTest({
    kind: row.kind,
    key: row.configuration_key,
    audience: row.audience,
    schemaVersion: row.schema_version,
    payload: row.payload_json,
  });
  return { result: automated.result, evidenceSha256: automated.evidenceSha256, reason: request.reason, testerId: automated.testerId };
}

function sameTest(row: TestRow, versionId: string, fact: ConfigurationTestFact) {
  return row.configuration_version_id === versionId && row.result === fact.result && row.evidence_sha256 === fact.evidenceSha256 && row.reason === fact.reason;
}

export async function testConfigurationVersion(pool: Pool, input: { versionId: string; actorUserId: string; idempotencyKey: string; requestId: string; test: unknown }) {
  const key = commandIdentity(input.idempotencyKey);
  const requestId = requestIdentity(input.requestId);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration-test:' || $1,0))", [input.versionId]);
    const version = await client.query<VersionRow>(`SELECT * FROM configuration_versions WHERE id=$1 FOR UPDATE`, [input.versionId]);
    if (!version.rows[0]) throw new ResearchApiError("CONFIGURATION_VERSION_NOT_FOUND", "配置版本不存在", 404);
    const fact = configurationTestFact(version.rows[0], input.test);
    const replay = await client.query<TestRow>(`SELECT * FROM configuration_test_results WHERE tested_by_user_id=$1 AND idempotency_key=$2`, [input.actorUserId,key]);
    if (replay.rows[0]) {
      if (!sameTest(replay.rows[0], input.versionId, fact)) throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一项配置测试", 409);
      return readVersionById(client, input.versionId);
    }
    const approval = await client.query(`SELECT id FROM configuration_approvals WHERE configuration_version_id=$1`, [input.versionId]);
    if (approval.rows[0]) throw new ResearchApiError("CONFIGURATION_ALREADY_REVIEWED", "已审批版本不能追加测试事实", 409);
    const id = randomUUID();
    await client.query(`
      INSERT INTO configuration_test_results(id,configuration_version_id,result,evidence_sha256,tested_by_user_id,reason,idempotency_key,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    `, [id,input.versionId,fact.result,fact.evidenceSha256,input.actorUserId,fact.reason,key,requestId]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
      VALUES($1,$2,$3,'configuration_version',$4,$5,$6)
    `, [randomUUID(),input.actorUserId,`configuration.test.${fact.result}`,input.versionId,JSON.stringify({ result: fact.result, evidenceSha256: fact.evidenceSha256, reason: fact.reason, ...(fact.testerId ? { testerId: fact.testerId } : {}) }),requestId]);
    return readVersionById(client, input.versionId);
  });
}

function sameApproval(row: ApprovalRow, versionId: string, approval: ReturnType<typeof normalizeConfigurationApproval>) {
  return row.configuration_version_id === versionId && row.decision === approval.decision && row.reason === approval.reason;
}

export async function reviewConfigurationVersion(pool: Pool, input: { versionId: string; reviewerUserId: string; idempotencyKey: string; requestId: string; approval: unknown }) {
  const approval = normalizeConfigurationApproval(input.approval);
  const key = commandIdentity(input.idempotencyKey);
  const requestId = requestIdentity(input.requestId);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration-review:' || $1,0))", [input.versionId]);
    const version = await client.query<VersionRow>(`SELECT * FROM configuration_versions WHERE id=$1 FOR UPDATE`, [input.versionId]);
    const row = version.rows[0];
    if (!row) throw new ResearchApiError("CONFIGURATION_VERSION_NOT_FOUND", "配置版本不存在", 404);
    if (row.created_by_user_id === input.reviewerUserId) throw new ResearchApiError("SELF_APPROVAL_FORBIDDEN", "创建者不能批准自己的配置版本", 403);
    const replay = await client.query<ApprovalRow>(`SELECT * FROM configuration_approvals WHERE reviewer_user_id=$1 AND idempotency_key=$2`, [input.reviewerUserId,key]);
    if (replay.rows[0]) {
      if (!sameApproval(replay.rows[0], input.versionId, approval)) throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一项配置审批", 409);
      return readVersionById(client, input.versionId);
    }
    const decided = await client.query(`SELECT id FROM configuration_approvals WHERE configuration_version_id=$1`, [input.versionId]);
    if (decided.rows[0]) throw new ResearchApiError("CONFIGURATION_ALREADY_REVIEWED", "配置版本已经完成审批", 409);
    const latestTest = await client.query<TestRow>(`SELECT * FROM configuration_test_results WHERE configuration_version_id=$1 ORDER BY sequence_no DESC LIMIT 1`, [input.versionId]);
    if (latestTest.rows[0]?.result !== "passed") throw new ResearchApiError("CONFIGURATION_TEST_REQUIRED", "配置版本必须先通过最新测试", 409);
    const id = randomUUID();
    await client.query(`
      INSERT INTO configuration_approvals(id,configuration_version_id,decision,reviewer_user_id,reason,idempotency_key,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)
    `, [id,input.versionId,approval.decision,input.reviewerUserId,approval.reason,key,requestId]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
      VALUES($1,$2,$3,'configuration_version',$4,$5,$6)
    `, [randomUUID(),input.reviewerUserId,`configuration.version.${approval.decision === "approve" ? "approved" : "rejected"}`,input.versionId,JSON.stringify({ decision: approval.decision, reason: approval.reason }),requestId]);
    return readVersionById(client, input.versionId);
  });
}

function sameSchedule(row: ScheduleRow, versionId: string, schedule: ReturnType<typeof normalizeConfigurationSchedule>) {
  return row.configuration_version_id === versionId && iso(row.scheduled_for) === schedule.scheduledFor && row.reason === schedule.reason;
}

export async function scheduleConfigurationVersion(pool: Pool, input: { versionId: string; actorUserId: string; idempotencyKey: string; requestId: string; schedule: unknown; now?: Date }) {
  const schedule = normalizeConfigurationSchedule(input.schedule);
  const key = commandIdentity(input.idempotencyKey);
  const requestId = requestIdentity(input.requestId);
  const now = input.now ?? new Date();
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration-schedule:' || $1,0))", [input.versionId]);
    const version = await client.query<VersionRow>(`SELECT * FROM configuration_versions WHERE id=$1 FOR UPDATE`, [input.versionId]);
    if (!version.rows[0]) throw new ResearchApiError("CONFIGURATION_VERSION_NOT_FOUND", "配置版本不存在", 404);
    const replay = await client.query<ScheduleRow>(`SELECT * FROM configuration_schedules WHERE scheduled_by_user_id=$1 AND idempotency_key=$2`, [input.actorUserId,key]);
    if (replay.rows[0]) {
      if (!sameSchedule(replay.rows[0], input.versionId, schedule)) throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一项配置调度", 409);
      return readVersionById(client, input.versionId);
    }
    const approved = await client.query<ApprovalRow>(`SELECT * FROM configuration_approvals WHERE configuration_version_id=$1`, [input.versionId]);
    if (approved.rows[0]?.decision !== "approve") throw new ResearchApiError("CONFIGURATION_APPROVAL_REQUIRED", "配置版本必须先通过独立审批", 409);
    const existing = await client.query(`SELECT id FROM configuration_schedules WHERE configuration_version_id=$1`, [input.versionId]);
    if (existing.rows[0]) throw new ResearchApiError("CONFIGURATION_ALREADY_SCHEDULED", "配置版本已经安排生效时间", 409);
    const scheduledAt = new Date(schedule.scheduledFor).getTime();
    if (scheduledAt < now.getTime()) throw new ResearchApiError("CONFIGURATION_SCHEDULE_IN_PAST", "scheduledFor 不能早于当前时间", 422);
    if (scheduledAt > now.getTime() + 5 * 366 * 24 * 60 * 60 * 1_000) throw new ResearchApiError("CONFIGURATION_SCHEDULE_TOO_FAR", "scheduledFor 不能超过五年", 422);
    const id = randomUUID();
    await client.query(`
      INSERT INTO configuration_schedules(id,configuration_version_id,scheduled_for,scheduled_by_user_id,reason,idempotency_key,request_id)
      VALUES($1,$2,$3::timestamptz,$4,$5,$6,$7)
    `, [id,input.versionId,schedule.scheduledFor,input.actorUserId,schedule.reason,key,requestId]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
      VALUES($1,$2,'configuration.version.scheduled','configuration_version',$3,$4,$5)
    `, [randomUUID(),input.actorUserId,input.versionId,JSON.stringify({ scheduledFor: schedule.scheduledFor, reason: schedule.reason }),requestId]);
    return readVersionById(client, input.versionId);
  });
}

function sameActivation(row: ActivationRow, versionId: string, activation: ReturnType<typeof normalizeConfigurationActivation>) {
  return row.configuration_version_id === versionId && row.action === activation.action && row.reason === activation.reason;
}

export async function activateConfigurationVersion(pool: Pool, input: { versionId: string; actorUserId: string; idempotencyKey: string; requestId: string; activation: unknown; now?: Date }) {
  const activation = normalizeConfigurationActivation(input.activation);
  const key = commandIdentity(input.idempotencyKey);
  const requestId = requestIdentity(input.requestId);
  const now = input.now ?? new Date();
  return transaction(pool, async (client) => {
    const version = await client.query<VersionRow>(`SELECT * FROM configuration_versions WHERE id=$1`, [input.versionId]);
    const row = version.rows[0];
    if (!row) throw new ResearchApiError("CONFIGURATION_VERSION_NOT_FOUND", "配置版本不存在", 404);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration-activation:' || $1 || ':' || $2 || ':' || $3,0))", [row.kind,row.configuration_key,row.audience]);
    const replay = await client.query<ActivationRow>(`SELECT * FROM configuration_activations WHERE actor_kind='user' AND actor_user_id=$1 AND idempotency_key=$2`, [input.actorUserId,key]);
    if (replay.rows[0]) {
      if (!sameActivation(replay.rows[0], input.versionId, activation)) throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一项配置生效操作", 409);
      return readVersionById(client, input.versionId);
    }
    const latestTest = await client.query<TestRow>(`SELECT * FROM configuration_test_results WHERE configuration_version_id=$1 ORDER BY sequence_no DESC LIMIT 1`, [input.versionId]);
    if (latestTest.rows[0]?.result !== "passed") throw new ResearchApiError("CONFIGURATION_TEST_REQUIRED", "配置版本必须保有通过的最新测试", 409);
    const approval = await client.query<ApprovalRow>(`SELECT * FROM configuration_approvals WHERE configuration_version_id=$1`, [input.versionId]);
    if (approval.rows[0]?.decision !== "approve") throw new ResearchApiError("CONFIGURATION_APPROVAL_REQUIRED", "配置版本必须先通过独立审批", 409);
    const current = await client.query<ActivationRow>(`
      SELECT activation.* FROM configuration_activations AS activation
      JOIN configuration_versions AS version ON version.id=activation.configuration_version_id
      WHERE version.kind=$1 AND version.configuration_key=$2 AND version.audience=$3
      ORDER BY activation.sequence_no DESC LIMIT 1 FOR UPDATE OF activation
    `, [row.kind,row.configuration_key,row.audience]);
    const currentId = current.rows[0]?.configuration_version_id ?? null;
    if (currentId === input.versionId) throw new ResearchApiError("CONFIGURATION_ALREADY_CURRENT", "配置版本已经是当前版本", 409);
    if (activation.action === "activate") {
      const schedule = await client.query<ScheduleRow>(`SELECT * FROM configuration_schedules WHERE configuration_version_id=$1`, [input.versionId]);
      if (!schedule.rows[0]) throw new ResearchApiError("CONFIGURATION_SCHEDULE_REQUIRED", "配置版本必须先安排生效时间", 409);
      if (new Date(schedule.rows[0].scheduled_for).getTime() > now.getTime()) throw new ResearchApiError("CONFIGURATION_NOT_DUE", "配置版本尚未到生效时间", 409);
    } else {
      if (!currentId) throw new ResearchApiError("CONFIGURATION_CURRENT_VERSION_MISSING", "配置流还没有可回滚的当前版本", 409);
      const historical = await client.query(`SELECT id FROM configuration_activations WHERE configuration_version_id=$1 LIMIT 1`, [input.versionId]);
      if (!historical.rows[0]) throw new ResearchApiError("CONFIGURATION_ROLLBACK_TARGET_INVALID", "回滚目标必须是同一配置流中曾生效的已验证版本", 409);
    }
    const id = randomUUID();
    await client.query(`
      INSERT INTO configuration_activations(id,configuration_version_id,previous_configuration_version_id,action,actor_user_id,actor_kind,reason,idempotency_key,request_id,created_at)
      VALUES($1,$2,$3,$4,$5,'user',$6,$7,$8,$9)
    `, [id,input.versionId,currentId,activation.action,input.actorUserId,activation.reason,key,requestId,now.toISOString()]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,request_id,created_at)
      VALUES($1,$2,$3,'configuration_version',$4,$5,$6,$7,$8)
    `, [randomUUID(),input.actorUserId,`configuration.version.${activation.action === "activate" ? "activated" : "rolled_back"}`,input.versionId,JSON.stringify({ currentConfigurationVersionId: currentId }),JSON.stringify({ configurationVersionId: input.versionId, action: activation.action, reason: activation.reason }),requestId,now.toISOString()]);
    return readVersionById(client, input.versionId);
  });
}
