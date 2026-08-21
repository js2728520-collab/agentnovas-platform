import type { Pool } from "pg";

import { requiredLegalDocumentTypes } from "./commercial-membership-domain.ts";
import { ResearchApiError } from "./research-errors.ts";

type LegalGateRow = {
  document_type: string;
  content_ready: boolean;
  accepted: boolean;
};

/**
 * Authorization-time legal check. This deliberately selects only metadata and
 * acceptance flags; the legal page remains the sole reader of full Markdown.
 */
export async function requireCommercialLegalConsentGate(
  pool: Pick<Pool, "query">,
  userId: string,
) {
  const result = await pool.query<LegalGateRow>(
    `SELECT d.document_type,
            (d.content_markdown IS NOT NULL
             AND char_length(btrim(d.content_markdown)) BETWEEN 40 AND 200000
             AND d.content_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'
             AND d.content_sha256 ~ '^[0-9a-f]{64}$'
             AND encode(sha256(convert_to(d.content_markdown,'UTF8')),'hex')=d.content_sha256) AS content_ready,
            (a.document_version_id IS NOT NULL) AS accepted
       FROM commercial_legal_document_versions d
       LEFT JOIN commercial_legal_acceptances a
         ON a.document_version_id=d.id AND a.user_id=$1
      WHERE d.status='active'
        AND d.effective_at<=now()
        AND d.approved_at IS NOT NULL
      ORDER BY d.document_type`,
    [userId],
  );
  const byType = new Map(result.rows.map((row) => [row.document_type, row]));
  const configurationComplete = result.rows.length === requiredLegalDocumentTypes.length
    && requiredLegalDocumentTypes.every((type) => byType.get(type)?.content_ready === true);
  if (!configurationComplete) {
    throw new ResearchApiError(
      "LEGAL_CONFIGURATION_INCOMPLETE",
      "当前法务文件尚未完成七项正文与审批配置",
      503,
      { requiredDocumentTypes: requiredLegalDocumentTypes },
    );
  }
  if (!result.rows.every((row) => row.accepted)) {
    throw new ResearchApiError("LEGAL_CONSENT_REQUIRED", "请先阅读并确认当前七项法务文件版本", 403);
  }
}
