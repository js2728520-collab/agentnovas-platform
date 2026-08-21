import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  commercialDisclosureSnapshotHash,
  normalizeCommercialDisclosureSubmission,
  type NormalizedCommercialDisclosureSubmission,
} from "./commercial-disclosure.ts";
import { ResearchApiError } from "./research-errors.ts";

type PublishRequestRow = {
  id: string;
  locale: string;
  product_identity_json: NormalizedCommercialDisclosureSubmission["productIdentity"];
  document_snapshot_json: NormalizedCommercialDisclosureSubmission["documents"];
  snapshot_sha256: string;
  status: "pending" | "approved" | "rejected";
  submitted_by_user_id: string;
  submission_reason: string;
  reviewed_by_user_id: string | null;
  review_note: string | null;
  reviewed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

function projectRequest(row: PublishRequestRow) {
  return {
    id: row.id,
    locale: row.locale,
    productIdentity: row.product_identity_json,
    documents: row.document_snapshot_json,
    snapshotSha256: row.snapshot_sha256,
    status: row.status.toUpperCase(),
    submittedByUserId: row.submitted_by_user_id,
    submissionReason: row.submission_reason,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewNote: row.review_note,
    reviewedAt: iso(row.reviewed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
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

export async function readCommercialDisclosureControl(pool: Pick<Pool, "query">) {
  const [active, requests] = await Promise.all([
    pool.query<{
      id: string;
      version: string;
      locale: string;
      product_identity_json: NormalizedCommercialDisclosureSubmission["productIdentity"];
      document_snapshot_json: NormalizedCommercialDisclosureSubmission["documents"];
      snapshot_sha256: string;
      published_by_user_id: string;
      published_at: Date | string;
    }>(`
      SELECT id,version::text,locale,product_identity_json,document_snapshot_json,
             snapshot_sha256,published_by_user_id,published_at
        FROM commercial_disclosure_bundles
       WHERE status='active'
       LIMIT 1
    `),
    pool.query<PublishRequestRow>(`
      SELECT id,locale,product_identity_json,document_snapshot_json,snapshot_sha256,status,
             submitted_by_user_id,submission_reason,reviewed_by_user_id,review_note,
             reviewed_at,created_at,updated_at
        FROM commercial_disclosure_publish_requests
       ORDER BY created_at DESC,id DESC
       LIMIT 50
    `),
  ]);
  const activeRow = active.rows[0];
  return {
    activeBundle: activeRow ? {
      id: activeRow.id,
      version: activeRow.version,
      locale: activeRow.locale,
      productIdentity: activeRow.product_identity_json,
      documents: activeRow.document_snapshot_json,
      snapshotSha256: activeRow.snapshot_sha256,
      publishedByUserId: activeRow.published_by_user_id,
      publishedAt: iso(activeRow.published_at),
    } : null,
    requests: requests.rows.map(projectRequest),
    readiness: {
      activeBundlePublished: Boolean(activeRow),
      documentCount: activeRow?.document_snapshot_json.length ?? 0,
      productIdentityComplete: Boolean(
        activeRow?.product_identity_json.operatorName
        && activeRow.product_identity_json.serviceRegion
        && activeRow.product_identity_json.supportEmail
        && activeRow.product_identity_json.primaryDomain
      ),
    },
  };
}

export async function submitCommercialDisclosure(
  pool: Pool,
  input: {
    actorUserId: string;
    idempotencyKey: string;
    requestId: string;
    submission: unknown;
  },
) {
  let normalized: NormalizedCommercialDisclosureSubmission;
  try {
    normalized = normalizeCommercialDisclosureSubmission(input.submission);
  } catch (error) {
    const code = error instanceof Error ? error.message : "DISCLOSURE_INPUT_INVALID";
    throw new ResearchApiError(code, "商业披露提交内容不完整或格式无效", 422);
  }
  const snapshotSha256 = commercialDisclosureSnapshotHash(normalized);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('commercial-disclosure-publish',0))");
    const replay = await client.query<PublishRequestRow>(`
      SELECT id,locale,product_identity_json,document_snapshot_json,snapshot_sha256,status,
             submitted_by_user_id,submission_reason,reviewed_by_user_id,review_note,
             reviewed_at,created_at,updated_at
        FROM commercial_disclosure_publish_requests
       WHERE submitted_by_user_id=$1 AND idempotency_key=$2
       FOR UPDATE
    `, [input.actorUserId, input.idempotencyKey]);
    if (replay.rows[0]) {
      if (replay.rows[0].snapshot_sha256 !== snapshotSha256) {
        throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键已用于另一份商业披露", 409);
      }
      return projectRequest(replay.rows[0]);
    }
    const pending = await client.query<{ id: string }>(`
      SELECT id FROM commercial_disclosure_publish_requests WHERE status='pending' LIMIT 1 FOR UPDATE
    `);
    if (pending.rows[0]) {
      throw new ResearchApiError("DISCLOSURE_REVIEW_PENDING", "已有商业披露等待复核，请先完成当前申请", 409, { requestId: pending.rows[0].id });
    }
    const id = randomUUID();
    const inserted = await client.query<PublishRequestRow>(`
      INSERT INTO commercial_disclosure_publish_requests (
        id,locale,product_identity_json,document_snapshot_json,snapshot_sha256,status,
        submitted_by_user_id,submission_reason,idempotency_key,request_id
      ) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,'pending',$6,$7,$8,$9)
      RETURNING id,locale,product_identity_json,document_snapshot_json,snapshot_sha256,status,
                submitted_by_user_id,submission_reason,reviewed_by_user_id,review_note,
                reviewed_at,created_at,updated_at
    `, [
      id,
      normalized.locale,
      JSON.stringify(normalized.productIdentity),
      JSON.stringify(normalized.documents),
      snapshotSha256,
      input.actorUserId,
      normalized.reason,
      input.idempotencyKey,
      input.requestId,
    ]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json)
      VALUES($1,$2,'commercial.disclosure.submitted','commercial_disclosure_publish_request',$3,'{}'::jsonb,$4::jsonb)
    `, [randomUUID(), input.actorUserId, id, JSON.stringify({ snapshotSha256, locale: normalized.locale, documentTypes: normalized.documents.map((document) => document.type) })]);
    return projectRequest(inserted.rows[0]);
  });
}

export async function decideCommercialDisclosure(
  pool: Pool,
  input: {
    requestId: string;
    reviewerUserId: string;
    decision: "approve" | "reject";
    note: string;
    idempotencyKey: string;
  },
) {
  const note = input.note.trim();
  if (note.length < 3 || note.length > 500) throw new ResearchApiError("DISCLOSURE_REVIEW_NOTE_INVALID", "复核说明需要 3–500 个字符", 422);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('commercial-disclosure-publish',0))");
    const result = await client.query<PublishRequestRow & { review_idempotency_key: string | null }>(`
      SELECT id,locale,product_identity_json,document_snapshot_json,snapshot_sha256,status,
             submitted_by_user_id,submission_reason,reviewed_by_user_id,review_note,
             review_idempotency_key,reviewed_at,created_at,updated_at
        FROM commercial_disclosure_publish_requests
       WHERE id=$1
       FOR UPDATE
    `, [input.requestId]);
    const row = result.rows[0];
    if (!row) throw new ResearchApiError("DISCLOSURE_REQUEST_NOT_FOUND", "商业披露发布申请不存在", 404);
    if (row.submitted_by_user_id === input.reviewerUserId) throw new ResearchApiError("SELF_APPROVAL_FORBIDDEN", "提交人不能复核自己的商业披露", 403);
    if (row.status !== "pending") {
      const existingDecision = row.status === "approved" ? "approve" : "reject";
      if (row.reviewed_by_user_id === input.reviewerUserId && row.review_idempotency_key === input.idempotencyKey && existingDecision === input.decision) {
        return projectRequest(row);
      }
      throw new ResearchApiError("DISCLOSURE_ALREADY_DECIDED", "商业披露发布申请已经完成复核", 409);
    }
    const normalized = normalizeCommercialDisclosureSubmission({
      locale: row.locale,
      reason: row.submission_reason,
      productIdentity: row.product_identity_json,
      documents: Object.fromEntries(row.document_snapshot_json.map((document) => [document.type, document.contentMarkdown])),
    });
    if (commercialDisclosureSnapshotHash(normalized) !== row.snapshot_sha256) {
      throw new ResearchApiError("DISCLOSURE_SNAPSHOT_MISMATCH", "商业披露快照完整性校验失败", 409);
    }
    const now = new Date().toISOString();
    if (input.decision === "approve") {
      await client.query(`UPDATE commercial_disclosure_bundles SET status='retired',retired_at=$1 WHERE status='active'`, [now]);
      await client.query(`UPDATE commercial_legal_document_versions SET status='retired' WHERE status='active'`, []);
      const bundleId = randomUUID();
      await client.query(`
        INSERT INTO commercial_disclosure_bundles (
          id,locale,product_identity_json,document_snapshot_json,snapshot_sha256,status,
          publish_request_id,submitted_by_user_id,published_by_user_id,published_at
        ) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,'active',$6,$7,$8,$9)
      `, [bundleId,row.locale,JSON.stringify(row.product_identity_json),JSON.stringify(row.document_snapshot_json),row.snapshot_sha256,row.id,row.submitted_by_user_id,input.reviewerUserId,now]);
      for (const document of normalized.documents) {
        const versionResult = await client.query<{ version: number }>(`
          SELECT COALESCE(max(version),0)::int+1 AS version
            FROM commercial_legal_document_versions
           WHERE document_type=$1
        `, [document.type]);
        await client.query(`
          INSERT INTO commercial_legal_document_versions (
            id,document_type,version,content_sha256,status,approved_by_user_id,approved_at,
            effective_at,content_locale,content_markdown,bundle_id
          ) VALUES ($1,$2,$3,$4,'active',$5,$6,$6,$7,$8,$9)
        `, [randomUUID(),document.type,versionResult.rows[0].version,document.contentSha256,input.reviewerUserId,now,row.locale,document.contentMarkdown,bundleId]);
      }
    }
    const decidedStatus = input.decision === "approve" ? "approved" : "rejected";
    const updated = await client.query<PublishRequestRow>(`
      UPDATE commercial_disclosure_publish_requests
         SET status=$2,reviewed_by_user_id=$3,review_note=$4,review_idempotency_key=$5,
             reviewed_at=$6,updated_at=$6
       WHERE id=$1
       RETURNING id,locale,product_identity_json,document_snapshot_json,snapshot_sha256,status,
                 submitted_by_user_id,submission_reason,reviewed_by_user_id,review_note,
                 reviewed_at,created_at,updated_at
    `, [row.id,decidedStatus,input.reviewerUserId,note,input.idempotencyKey,now]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json)
      VALUES($1,$2,$3,'commercial_disclosure_publish_request',$4,$5::jsonb,$6::jsonb)
    `, [randomUUID(),input.reviewerUserId,`commercial.disclosure.${decidedStatus}`,row.id,JSON.stringify({ status: "pending" }),JSON.stringify({ status: decidedStatus, snapshotSha256: row.snapshot_sha256, note })]);
    return projectRequest(updated.rows[0]);
  });
}
