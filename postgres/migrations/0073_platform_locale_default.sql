-- New accounts follow the confirmed English fallback. Historical rows are not
-- rewritten because an existing locale may represent an explicit preference.
ALTER TABLE users ALTER COLUMN locale SET DEFAULT 'en-US';

-- NOT VALID preserves historical non-standard values while enforcing the
-- seven-locale contract for every new INSERT or UPDATE. The migration runner
-- wraps this replacement in one transaction, so concurrent sessions never see
-- a committed interval without the constraint.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_supported_check;
ALTER TABLE users ADD CONSTRAINT users_locale_supported_check CHECK (
  locale IN ('en-US','zh-CN','zh-TW','ru-RU','es-ES','ja-JP','ko-KR')
) NOT VALID;
