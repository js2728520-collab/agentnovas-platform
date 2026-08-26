import type { Pool } from "pg";

import {
  evaluateRegisteredFeatureFlag,
  normalizeRegisteredFeatureFlagPayload,
  type FeatureFlagEvaluationContext,
} from "./configuration-family-registry.ts";
import { configurationPayloadSha256 } from "./versioned-configuration-domain.ts";

type ActiveFeatureFlagRow = {
  configuration_version_id: string;
  schema_version: number;
  payload_json: Record<string, unknown>;
  payload_sha256: string;
};

const SHA256 = /^[a-f0-9]{64}$/;

function result(
  decision: ReturnType<typeof evaluateRegisteredFeatureFlag> | { enabled: false; reason: "configuration_unavailable" },
  row: ActiveFeatureFlagRow | null,
) {
  return {
    ...decision,
    configurationVersionId: row?.configuration_version_id ?? null,
    payloadSha256: row?.payload_sha256 ?? null,
  };
}

export async function readClientFeatureFlagDecision(
  queryable: Pick<Pool, "query">,
  input: {
    key: "client.strategy_research";
    environmentEnabled: boolean;
    userId?: string | null;
    organizationIds?: readonly string[];
    applicationVersion?: string | null;
    now?: Date;
  },
) {
  if (!input.environmentEnabled) {
    return result(evaluateRegisteredFeatureFlag({ environmentEnabled: false, payload: null }), null);
  }
  let row: ActiveFeatureFlagRow | null;
  try {
    const projection = await queryable.query<ActiveFeatureFlagRow>(`
      SELECT configuration_version_id,schema_version,payload_json,payload_sha256
        FROM configuration_client_active_feature_flag($1)
    `, [input.key]);
    row = projection.rows[0] ?? null;
  } catch {
    return result({ enabled: false, reason: "configuration_unavailable" }, null);
  }
  if (!row) return result(evaluateRegisteredFeatureFlag({ environmentEnabled: true, payload: null }), null);
  if (!row.configuration_version_id || row.configuration_version_id.length > 160
    || ![1, 2].includes(row.schema_version) || !SHA256.test(row.payload_sha256)) {
    return result({ enabled: false, reason: "configuration_invalid" }, row);
  }
  let payload: Record<string, unknown>;
  try {
    payload = normalizeRegisteredFeatureFlagPayload(row.schema_version, row.payload_json);
  } catch {
    return result({ enabled: false, reason: "configuration_invalid" }, row);
  }
  if (configurationPayloadSha256(payload) !== row.payload_sha256) {
    return result({ enabled: false, reason: "configuration_invalid" }, row);
  }
  const context: FeatureFlagEvaluationContext = {
    userId: input.userId,
    organizationIds: input.organizationIds,
    applicationVersion: input.applicationVersion,
    now: input.now,
  };
  const decision = evaluateRegisteredFeatureFlag({
    environmentEnabled: true,
    schemaVersion: row.schema_version,
    payload,
    context,
  });
  return result(decision, row);
}
