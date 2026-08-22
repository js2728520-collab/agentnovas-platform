import assert from "node:assert/strict";
import test from "node:test";

import { createResearchRun } from "../lib/postgres-research-queue.ts";
import { saveResearchEvaluation, updateCandidateValidation } from "../lib/research-repository.ts";

test("serializes research brief before crossing the PostgreSQL driver boundary", async () => {
  const database = {
    async query(sql, values) {
      assert.match(sql, /\$6::jsonb/);
      assert.equal(typeof values[5], "string");
      assert.deepEqual(JSON.parse(values[5]), {
        symbol: "BTCUSDT",
        timeframe: "15m",
        filters: { regime: "trend" },
      });
      return {
        rows: [{
          id: "run-a",
          owner_user_id: "user-a",
          conversation_id: "conversation-a",
          exchange_account_id: "exchange-a",
          mode: "standard",
          stage: "requirements",
          status: "queued",
          progress: 0,
          brief_json: JSON.parse(values[5]),
          lease_owner: null,
          lease_expires_at: null,
          attempts: 0,
          cancel_requested_at: null,
          result_json: null,
          final_conclusion: null,
          event_sequence: "0",
          candidate_budget: 6,
          backtest_budget: 60,
          model_call_budget: 24,
          backtests_used: 0,
          model_calls_used: 0,
          last_error_code: null,
          last_error_message: null,
          completed_at: null,
          created_at: new Date("2026-08-18T10:00:00.000Z"),
          updated_at: new Date("2026-08-18T10:00:00.000Z"),
        }],
      };
    },
  };

  const run = await createResearchRun(database, {
    ownerUserId: "user-a",
    conversationId: "conversation-a",
    exchangeAccountId: "exchange-a",
    mode: "standard",
    brief: {
      symbol: "BTCUSDT",
      timeframe: "15m",
      filters: { regime: "trend" },
    },
    idempotencyKey: "research-json-parameter",
  });

  assert.equal(run.status, "queued");
});

test("serializes evaluation metrics and data quality as explicit JSONB parameters", async () => {
  const database = {
    async query(sql, values) {
      assert.match(sql, /\$8::jsonb/);
      assert.match(sql, /\$9::jsonb/);
      assert.equal(typeof values[7], "string");
      assert.equal(typeof values[8], "string");
      assert.deepEqual(JSON.parse(values[7]), { netReturnPct: 1.2, warnings: ["估算费率"] });
      assert.deepEqual(JSON.parse(values[8]), { isVerifiable: true });
      assert.equal(values[9], "a".repeat(64));
      assert.equal(values[10], "b".repeat(64));
      assert.equal(values[11], "4.0.0-dsl-v3-unified");
      assert.equal(values[12], "base_cost");
      return { rows: [{ id: values[0] }] };
    },
  };

  await saveResearchEvaluation(database, {
    runId: "run-a",
    candidateId: "candidate-a",
    kind: "final_holdout",
    windowIndex: 0,
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date("2026-02-01T00:00:00.000Z"),
    metrics: { netReturnPct: 1.2, warnings: ["估算费率"] },
    dataQuality: { isVerifiable: true },
    parameterSetSha256: "a".repeat(64),
    dataSliceSha256: "b".repeat(64),
    backtestEngineVersion: "4.0.0-dsl-v3-unified",
    costScenario: "base_cost",
    passed: true,
  });
});

test("serializes candidate rejection reasons and DSL as explicit JSONB parameters", async () => {
  const database = {
    async query(sql, values) {
      assert.match(sql, /\$5::jsonb/);
      assert.match(sql, /\$6::jsonb/);
      assert.deepEqual(JSON.parse(values[4]), ["样本外收益未达标"]);
      assert.deepEqual(JSON.parse(values[5]), { schemaVersion: 2 });
      return { rows: [] };
    },
  };

  await updateCandidateValidation(database, {
    candidateId: "candidate-a",
    status: "rejected",
    score: -1,
    validationLabel: "STANDARD_FAILED",
    reasons: ["样本外收益未达标"],
    dsl: { schemaVersion: 2 },
  });
});
