import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type { ReleaseManagementPayload, ReleaseVersion } from "../packages/contracts/src/release-management.ts";
import { encodeCommercialCursor, type CommercialCursor } from "./commercial-api-support.ts";
import {
  normalizeReleaseDeployment,
  normalizeReleaseRegistration,
  normalizeReleaseVerification,
  safeRuntimeReleaseMetadata,
  type NormalizedReleaseDeployment,
  type NormalizedReleaseRegistration,
  type NormalizedReleaseVerification,
  type ReleaseEnvironment,
} from "./release-version-domain.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type VersionRow = {
  id: string;
  version_tag: string;
  channel: "beta" | "stable";
  commit_sha: string;
  artifact_sha256: string;
  migration_version: string;
  release_notes: string;
  reason: string;
  created_by_user_id: string;
  idempotency_key: string;
  request_id: string;
  created_at: Date | string;
};

type VerificationRow = {
  id: string;
  release_version_id: string;
  decision: "approve" | "reject";
  evidence_sha256: string;
  ci_run_url: string | null;
  reviewer_user_id: string;
  reason: string;
  idempotency_key: string;
  request_id: string;
  created_at: Date | string;
};

type DeploymentRow = {
  id: string;
  sequence_no: string;
  release_version_id: string;
  previous_release_version_id: string | null;
  environment: ReleaseEnvironment;
  action: "deploy" | "rollback";
  status: "succeeded" | "failed";
  evidence_sha256: string;
  actor_user_id: string;
  reason: string;
  idempotency_key: string;
  request_id: string;
  created_at: Date | string;
};

type CurrentRow = DeploymentRow & { version_tag: string; commit_sha: string };

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

function commandIdentity(value: string, label: string) {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 160) throw new ResearchApiError("RELEASE_IDEMPOTENCY_KEY_INVALID", `${label}需要 8–160 个字符`, 422);
  return normalized;
}

function requestIdentity(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new ResearchApiError("RELEASE_REQUEST_ID_INVALID", "requestId 无效", 422);
  return normalized;
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

function sameRegistration(row: VersionRow, input: NormalizedReleaseRegistration) {
  return row.version_tag === input.versionTag && row.channel === input.channel && row.commit_sha === input.commitSha
    && row.artifact_sha256 === input.artifactSha256 && row.migration_version === input.migrationVersion
    && row.release_notes === input.releaseNotes && row.reason === input.reason;
}

function sameVerification(row: VerificationRow, releaseVersionId: string, input: NormalizedReleaseVerification) {
  return row.release_version_id === releaseVersionId && row.decision === input.decision
    && row.evidence_sha256 === input.evidenceSha256 && row.ci_run_url === (input.ciRunUrl ?? null)
    && row.reason === input.reason;
}

function sameDeployment(row: DeploymentRow, releaseVersionId: string, input: NormalizedReleaseDeployment) {
  return row.release_version_id === releaseVersionId && row.environment === input.environment && row.action === input.action
    && row.status === input.status && row.evidence_sha256 === input.evidenceSha256 && row.reason === input.reason;
}

function projectVerification(row: VerificationRow) {
  return {
    id: row.id,
    decision: row.decision,
    evidenceSha256: row.evidence_sha256,
    ciRunUrl: row.ci_run_url,
    reviewerUserId: row.reviewer_user_id,
    reason: row.reason,
    createdAt: iso(row.created_at),
  };
}

function projectDeployment(row: DeploymentRow) {
  return {
    id: row.id,
    environment: row.environment,
    action: row.action,
    status: row.status,
    previousReleaseVersionId: row.previous_release_version_id,
    evidenceSha256: row.evidence_sha256,
    actorUserId: row.actor_user_id,
    reason: row.reason,
    createdAt: iso(row.created_at),
  };
}

function projectVersion(
  row: VersionRow,
  verification: VerificationRow | undefined,
  deployments: DeploymentRow[],
  currentRows: Map<ReleaseEnvironment, CurrentRow>,
): ReleaseVersion {
  const currentEnvironments = (["staging", "production"] as const).filter((environment) => currentRows.get(environment)?.release_version_id === row.id);
  const successes = deployments.filter((deployment) => deployment.status === "succeeded");
  const rolledBack = currentEnvironments.some((environment) => {
    const current = currentRows.get(environment);
    return current?.release_version_id === row.id && current.action === "rollback";
  });
  const status = verification?.decision === "reject" ? "rejected"
    : !verification ? "draft"
    : successes.length === 0 ? "verified"
    : currentEnvironments.length === 0 ? "superseded"
    : rolledBack ? "rolled_back"
    : "deployed";
  return {
    id: row.id,
    versionTag: row.version_tag,
    channel: row.channel,
    commitSha: row.commit_sha,
    artifactSha256: row.artifact_sha256,
    migrationVersion: row.migration_version,
    releaseNotes: row.release_notes,
    createdByUserId: row.created_by_user_id,
    reason: row.reason,
    createdAt: iso(row.created_at),
    status,
    verification: verification ? projectVerification(verification) : null,
    deployments: deployments.map(projectDeployment),
    currentEnvironments: [...currentEnvironments],
  };
}

async function currentDeployments(queryable: Queryable) {
  const result = await queryable.query<CurrentRow>(`
    SELECT DISTINCT ON (deployment.environment)
           deployment.*,version.version_tag,version.commit_sha
      FROM release_deployments AS deployment
      JOIN release_versions AS version ON version.id=deployment.release_version_id
     WHERE deployment.status='succeeded'
     ORDER BY deployment.environment,deployment.sequence_no DESC
  `);
  return new Map(result.rows.map((row) => [row.environment, row]));
}

async function readVersions(queryable: Queryable, input: { limit: number; cursor: CommercialCursor | null; id?: string }) {
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
    SELECT id,version_tag,channel,commit_sha,artifact_sha256,migration_version,release_notes,
           reason,created_by_user_id,idempotency_key,request_id,created_at
      FROM release_versions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC,id DESC
     LIMIT $${values.length}
  `, values);
  const ids = versions.rows.map((row) => row.id);
  if (!ids.length) return { versions: versions.rows, verifications: [] as VerificationRow[], deployments: [] as DeploymentRow[] };
  const verifications = await queryable.query<VerificationRow>(`SELECT * FROM release_verifications WHERE release_version_id=ANY($1::text[])`, [ids]);
  const deployments = await queryable.query<DeploymentRow>(`SELECT * FROM release_deployments WHERE release_version_id=ANY($1::text[]) ORDER BY sequence_no DESC`, [ids]);
  return { versions: versions.rows, verifications: verifications.rows, deployments: deployments.rows };
}

async function readReleaseById(queryable: Queryable, id: string) {
  const records = await readVersions(queryable, { limit: 1, cursor: null, id });
  const current = await currentDeployments(queryable);
  const row = records.versions[0];
  if (!row) throw new ResearchApiError("RELEASE_VERSION_NOT_FOUND", "发布版本不存在", 404);
  return projectVersion(
    row,
    records.verifications.find((item) => item.release_version_id === row.id),
    records.deployments.filter((item) => item.release_version_id === row.id),
    current,
  );
}

export async function readReleaseManagement(
  queryable: Queryable,
  input: { limit: number; cursor: CommercialCursor | null; environment?: Record<string, string | undefined> },
): Promise<ReleaseManagementPayload> {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
  const records = await readVersions(queryable, { limit: limit + 1, cursor: input.cursor });
  const current = await currentDeployments(queryable);
  const visible = records.versions.slice(0, limit);
  const visibleIds = new Set(visible.map((row) => row.id));
  const releases = visible.map((row) => projectVersion(
    row,
    records.verifications.find((item) => item.release_version_id === row.id),
    records.deployments.filter((item) => item.release_version_id === row.id),
    current,
  ));
  const currentValue = (environment: ReleaseEnvironment) => {
    const row = current.get(environment);
    return row ? { id: row.release_version_id, versionTag: row.version_tag, commitSha: row.commit_sha } : null;
  };
  const last = visible.at(-1);
  return {
    runtime: safeRuntimeReleaseMetadata(input.environment ?? process.env),
    releases: releases.filter((item) => visibleIds.has(item.id)),
    currentByEnvironment: { staging: currentValue("staging"), production: currentValue("production") },
    nextCursor: records.versions.length > limit && last ? encodeCommercialCursor({ createdAt: iso(last.created_at), id: last.id }) : null,
  };
}

export async function createReleaseVersion(pool: Pool, input: {
  actorUserId: string;
  idempotencyKey: string;
  requestId: string;
  release: unknown;
}) {
  const release = normalizeReleaseRegistration(input.release);
  const key = commandIdentity(input.idempotencyKey, "幂等键");
  const requestId = requestIdentity(input.requestId);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('release-version-register',0))");
    const replay = await client.query<VersionRow>(`SELECT * FROM release_versions WHERE created_by_user_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.actorUserId, key]);
    if (replay.rows[0]) {
      if (!sameRegistration(replay.rows[0], release)) throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一个发布版本", 409);
      return readReleaseById(client, replay.rows[0].id);
    }
    const collision = await client.query<{ id: string }>(`SELECT id FROM release_versions WHERE version_tag=$1 OR commit_sha=$2 LIMIT 1`, [release.versionTag, release.commitSha]);
    if (collision.rows[0]) throw new ResearchApiError("RELEASE_IDENTITY_CONFLICT", "版本标签或 commit SHA 已登记", 409);
    const id = randomUUID();
    await client.query(`
      INSERT INTO release_versions(
        id,version_tag,channel,commit_sha,artifact_sha256,migration_version,release_notes,reason,
        created_by_user_id,idempotency_key,request_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [id,release.versionTag,release.channel,release.commitSha,release.artifactSha256,release.migrationVersion,release.releaseNotes,release.reason,input.actorUserId,key,requestId]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
      VALUES($1,$2,'release.version.registered','release_version',$3,$4,$5)
    `, [randomUUID(),input.actorUserId,id,JSON.stringify({ versionTag: release.versionTag, commitSha: release.commitSha, artifactSha256: release.artifactSha256, migrationVersion: release.migrationVersion, channel: release.channel, reason: release.reason }),requestId]);
    return readReleaseById(client, id);
  });
}

export async function verifyReleaseVersion(pool: Pool, input: {
  releaseVersionId: string;
  reviewerUserId: string;
  idempotencyKey: string;
  requestId: string;
  verification: unknown;
}) {
  const verification = normalizeReleaseVerification(input.verification);
  const key = commandIdentity(input.idempotencyKey, "幂等键");
  const requestId = requestIdentity(input.requestId);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('release-version-verify:' || $1,0))", [input.releaseVersionId]);
    const release = await client.query<VersionRow>(`SELECT * FROM release_versions WHERE id=$1 FOR UPDATE`, [input.releaseVersionId]);
    const row = release.rows[0];
    if (!row) throw new ResearchApiError("RELEASE_VERSION_NOT_FOUND", "发布版本不存在", 404);
    if (row.created_by_user_id === input.reviewerUserId) throw new ResearchApiError("SELF_APPROVAL_FORBIDDEN", "提交人不能复核自己的发布版本", 403);
    const replay = await client.query<VerificationRow>(`SELECT * FROM release_verifications WHERE reviewer_user_id=$1 AND idempotency_key=$2`, [input.reviewerUserId,key]);
    if (replay.rows[0]) {
      if (!sameVerification(replay.rows[0], input.releaseVersionId, verification)) throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一项版本复核", 409);
      return readReleaseById(client, input.releaseVersionId);
    }
    const decided = await client.query<{ id: string }>(`SELECT id FROM release_verifications WHERE release_version_id=$1`, [input.releaseVersionId]);
    if (decided.rows[0]) throw new ResearchApiError("RELEASE_ALREADY_VERIFIED", "发布版本已经完成复核", 409);
    const id = randomUUID();
    await client.query(`
      INSERT INTO release_verifications(
        id,release_version_id,decision,evidence_sha256,ci_run_url,reviewer_user_id,reason,idempotency_key,request_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [id,input.releaseVersionId,verification.decision,verification.evidenceSha256,verification.ciRunUrl ?? null,input.reviewerUserId,verification.reason,key,requestId]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,request_id)
      VALUES($1,$2,$3,'release_version',$4,$5,$6,$7)
    `, [randomUUID(),input.reviewerUserId,`release.version.${verification.decision === "approve" ? "approved" : "rejected"}`,input.releaseVersionId,JSON.stringify({ status: "draft" }),JSON.stringify({ decision: verification.decision, evidenceSha256: verification.evidenceSha256, ciRunUrl: verification.ciRunUrl ?? null, reason: verification.reason }),requestId]);
    return readReleaseById(client, input.releaseVersionId);
  });
}

export async function recordReleaseDeployment(pool: Pool, input: {
  releaseVersionId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestId: string;
  deployment: unknown;
}) {
  const deployment = normalizeReleaseDeployment(input.deployment);
  const key = commandIdentity(input.idempotencyKey, "幂等键");
  const requestId = requestIdentity(input.requestId);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('release-deployment:' || $1,0))", [deployment.environment]);
    const replay = await client.query<DeploymentRow>(`SELECT * FROM release_deployments WHERE actor_user_id=$1 AND idempotency_key=$2`, [input.actorUserId,key]);
    if (replay.rows[0]) {
      if (!sameDeployment(replay.rows[0], input.releaseVersionId, deployment)) throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一项部署记录", 409);
      return projectDeployment(replay.rows[0]);
    }
    const release = await client.query<VersionRow>(`SELECT * FROM release_versions WHERE id=$1 FOR UPDATE`, [input.releaseVersionId]);
    if (!release.rows[0]) throw new ResearchApiError("RELEASE_VERSION_NOT_FOUND", "发布版本不存在", 404);
    const verification = await client.query<VerificationRow>(`SELECT * FROM release_verifications WHERE release_version_id=$1`, [input.releaseVersionId]);
    if (verification.rows[0]?.decision !== "approve") throw new ResearchApiError("RELEASE_NOT_VERIFIED", "发布版本尚未通过独立复核", 409);
    const current = await client.query<DeploymentRow>(`
      SELECT * FROM release_deployments
       WHERE environment=$1 AND status='succeeded'
       ORDER BY sequence_no DESC LIMIT 1 FOR UPDATE
    `, [deployment.environment]);
    const currentId = current.rows[0]?.release_version_id ?? null;
    if (deployment.action === "deploy" && deployment.status === "succeeded" && currentId === input.releaseVersionId) {
      throw new ResearchApiError("RELEASE_ALREADY_CURRENT", "该版本已经是当前环境版本", 409);
    }
    if (deployment.action === "deploy" && deployment.status === "succeeded" && deployment.environment === "production") {
      const staging = await client.query<{ id: string }>(`
        SELECT id FROM release_deployments
         WHERE release_version_id=$1 AND environment='staging' AND status='succeeded'
         LIMIT 1
      `, [input.releaseVersionId]);
      if (!staging.rows[0]) throw new ResearchApiError("STAGING_DEPLOYMENT_REQUIRED", "production 部署前必须先登记同版本 staging 成功证据", 409);
    }
    if (deployment.action === "rollback") {
      if (!currentId) throw new ResearchApiError("RELEASE_CURRENT_VERSION_MISSING", "当前环境没有可回滚的已登记版本", 409);
      if (currentId === input.releaseVersionId) throw new ResearchApiError("RELEASE_ROLLBACK_TARGET_CURRENT", "回滚目标不能是当前环境版本", 409);
      const historical = await client.query<{ id: string }>(`
        SELECT id FROM release_deployments
         WHERE release_version_id=$1 AND environment=$2 AND status='succeeded'
         LIMIT 1
      `, [input.releaseVersionId,deployment.environment]);
      if (!historical.rows[0]) throw new ResearchApiError("RELEASE_ROLLBACK_TARGET_INVALID", "回滚目标从未在当前环境成功部署", 409);
    }
    const id = randomUUID();
    const previousReleaseVersionId = currentId && currentId !== input.releaseVersionId ? currentId : null;
    const inserted = await client.query<DeploymentRow>(`
      INSERT INTO release_deployments(
        id,release_version_id,previous_release_version_id,environment,action,status,evidence_sha256,
        actor_user_id,reason,idempotency_key,request_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [id,input.releaseVersionId,previousReleaseVersionId,deployment.environment,deployment.action,deployment.status,deployment.evidenceSha256,input.actorUserId,deployment.reason,key,requestId]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,request_id)
      VALUES($1,$2,$3,'release_deployment',$4,$5,$6,$7)
    `, [randomUUID(),input.actorUserId,`release.${deployment.action}.${deployment.status}`,id,JSON.stringify({ currentReleaseVersionId: currentId, environment: deployment.environment }),JSON.stringify({ releaseVersionId: input.releaseVersionId, evidenceSha256: deployment.evidenceSha256, reason: deployment.reason, environment: deployment.environment, action: deployment.action, status: deployment.status }),requestId]);
    return projectDeployment(inserted.rows[0]);
  });
}
