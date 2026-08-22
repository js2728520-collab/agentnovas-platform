ALTER TABLE commercial_legal_document_versions
  ADD COLUMN IF NOT EXISTS content_locale text,
  ADD COLUMN IF NOT EXISTS content_markdown text;

ALTER TABLE commercial_legal_document_versions
  DROP CONSTRAINT IF EXISTS commercial_legal_document_versions_content_locale_check;
ALTER TABLE commercial_legal_document_versions
  ADD CONSTRAINT commercial_legal_document_versions_content_locale_check
  CHECK (content_locale IS NULL OR content_locale ~ '^[a-z]{2}(-[A-Z]{2})?$');

ALTER TABLE commercial_legal_document_versions
  DROP CONSTRAINT IF EXISTS commercial_legal_document_versions_content_size_check;
ALTER TABLE commercial_legal_document_versions
  ADD CONSTRAINT commercial_legal_document_versions_content_size_check
  CHECK (content_markdown IS NULL OR char_length(content_markdown) BETWEEN 40 AND 200000);

CREATE OR REPLACE FUNCTION commercial_legal_content_immutable() RETURNS trigger AS $$
BEGIN
  IF (OLD.approved_at IS NOT NULL OR OLD.status IN ('active','retired'))
     AND (NEW.content_locale IS DISTINCT FROM OLD.content_locale
       OR NEW.content_markdown IS DISTINCT FROM OLD.content_markdown
       OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256) THEN
    RAISE EXCEPTION 'approved commercial legal content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_commercial_legal_content_immutable ON commercial_legal_document_versions;
CREATE TRIGGER trg_commercial_legal_content_immutable
BEFORE UPDATE ON commercial_legal_document_versions
FOR EACH ROW EXECUTE FUNCTION commercial_legal_content_immutable();

