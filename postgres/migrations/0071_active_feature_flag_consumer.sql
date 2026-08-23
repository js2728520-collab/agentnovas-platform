CREATE OR REPLACE FUNCTION configuration_client_active_feature_flag(
  p_configuration_key text
) RETURNS TABLE(
  configuration_version_id text,
  schema_version integer,
  payload_json jsonb,
  payload_sha256 text
) AS $$
  SELECT version.id,version.schema_version,version.payload_json,version.payload_sha256
    FROM configuration_activations AS activation
    JOIN configuration_versions AS version ON version.id=activation.configuration_version_id
   WHERE version.kind='feature_flag'
     AND version.configuration_key=p_configuration_key
     AND version.audience='client'
   ORDER BY activation.sequence_no DESC
   LIMIT 1
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION configuration_client_active_feature_flag(text) FROM PUBLIC;
