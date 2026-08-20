import { createHash } from "node:crypto";

export type CommercialLegalDocumentRow = {
  id: string;
  document_type: string;
  version: number;
  content_sha256: string;
  content_locale: string | null;
  content_markdown: string | null;
  effective_at?: Date | string;
};

export function commercialLegalContentSha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hasReadableCommercialLegalContent(
  row: CommercialLegalDocumentRow,
) {
  const content = row.content_markdown;
  const locale = row.content_locale;
  return typeof content === "string"
    && content.trim().length >= 40
    && content.length <= 200_000
    && typeof locale === "string"
    && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)
    && commercialLegalContentSha256(content) === row.content_sha256;
}

