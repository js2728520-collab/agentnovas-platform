import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration93 = new URL("../postgres/migrations/0093_ai_control_plane.sql", import.meta.url);
const migration94 = new URL("../postgres/migrations/0094_ai_secret_custody.sql", import.meta.url);

test("0093 freezes the complete control-plane resource and compatibility contract", async () => {
  const sql = await readFile(migration93, "utf8");
  for (const resource of [
    "ai_provider_connections",
    "ai_connection_revisions",
    "ai_model_deployments",
    "ai_deployment_revisions",
    "ai_binding_policies",
    "ai_binding_policy_revisions",
    "ai_binding_targets",
    "ai_probe_receipts",
    "ai_invocation_receipts",
    "ai_usage_events",
    "ai_rate_card_revisions",
    "ai_budget_policies",
    "ai_budget_alerts",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${resource}\\b`));

  for (const role of [
    "requirements", "market_regime", "proposal_a", "proposal_b", "adversarial_review", "risk_review", "report",
    "market_summary", "adversarial_explanation", "risk_explanation", "assistant_message", "strategy_generation",
  ]) assert.match(sql, new RegExp(`'${role}'`));

  assert.match(sql, /deployment_revision_id text NOT NULL REFERENCES ai_deployment_revisions\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /CHECK \(target_rank BETWEEN 0 AND 2\)/);
  assert.match(sql, /maintenance_ai_control_plane_snapshot_safe/);
  assert.match(sql, /maintenance_ai_connections_safe/);
  assert.match(sql, /maintenance_ai_deployments_safe/);
  assert.match(sql, /maintenance_ai_probe_receipts_safe/);
  assert.match(sql, /maintenance_ai_budgets_safe/);
  assert.match(sql, /maintenance_ai_usage_events_v2_safe/);
  assert.doesNotMatch(sql.match(/CREATE OR REPLACE VIEW maintenance_ai_usage_events_v2_safe[\s\S]*?COMMENT ON VIEW/)?.[0] ?? "", /prompt|response_content|secret_ref|endpoint|provider_request_id/i);
});

test("0094 stores only encrypted commands in the web database and clears successful envelopes", async () => {
  const sql = await readFile(migration94, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_secret_broker_keys\b/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_secret_commands\b/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_secret_receipts\b/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_legacy_secret_migration_receipts\b/);
  assert.match(sql, /wrapped_data_key text/);
  assert.match(sql, /ciphertext text/);
  assert.match(sql, /status='succeeded'[\s\S]*wrapped_data_key IS NULL[\s\S]*ciphertext IS NULL/);
  assert.doesNotMatch(sql, /plaintext_api_key|decrypted_api_key|private_key_pem/i);
});
