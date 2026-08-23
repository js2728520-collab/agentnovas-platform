import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import {
  beginClientAiInference,
  cancelClientAiInference,
  completeClientAiInference,
  failClientAiInference,
  readClientAiInferenceReplay,
  reconcileExpiredClientAiInferences,
} from "../lib/client-ai-inference-service.ts";
import { settleAiCreditReservation } from "../lib/ai-credit-service.ts";
import { resolveClientPlatformLlmConfig } from "../lib/client-platform-llm.ts";
import { encryptLlmProfileSecret } from "../lib/integration-credentials.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `client_ai_inference_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const previousLlmKey = process.env.LLM_PROFILE_ENCRYPTION_KEY;

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  process.env.LLM_PROFILE_ENCRYPTION_KEY = "test-only-client-runtime-key-32-chars";
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users(id text PRIMARY KEY);
    CREATE TABLE llm_profiles(id text PRIMARY KEY,current_revision_id text,enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE llm_profile_revisions(id text PRIMARY KEY,profile_id text NOT NULL,provider_name text NOT NULL,base_url text NOT NULL,model_name text NOT NULL,encrypted_api_key text NOT NULL,enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE agent_role_bindings(id text PRIMARY KEY,role text UNIQUE NOT NULL,llm_profile_id text NOT NULL,enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE ai_credit_accounts(id text PRIMARY KEY,user_id text UNIQUE NOT NULL,available_credits numeric(36,0) NOT NULL DEFAULT 0 CHECK(available_credits>=0),reserved_credits numeric(36,0) NOT NULL DEFAULT 0 CHECK(reserved_credits>=0),version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ai_credit_reservations(id text PRIMARY KEY,account_id text NOT NULL REFERENCES ai_credit_accounts(id),estimated_credits numeric(36,0) NOT NULL CHECK(estimated_credits>0),settled_credits numeric(36,0),status text NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','settled','released')),idempotency_key text UNIQUE NOT NULL,expires_at timestamptz NOT NULL,version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ai_credit_ledger_entries(id text PRIMARY KEY,account_id text NOT NULL REFERENCES ai_credit_accounts(id),entry_type text NOT NULL,available_delta numeric(36,0) NOT NULL,reserved_delta numeric(36,0) NOT NULL,balance_available numeric(36,0) NOT NULL CHECK(balance_available>=0),balance_reserved numeric(36,0) NOT NULL CHECK(balance_reserved>=0),source_type text NOT NULL,source_id text NOT NULL,reservation_id text REFERENCES ai_credit_reservations(id),cost_model_version text,usage_json jsonb,idempotency_key text UNIQUE NOT NULL,request_id text NOT NULL,created_by_user_id text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_type,source_id,entry_type));
  `);
  await pool.query(await readFile(new URL("../postgres/migrations/0038_client_ai_runtime_credits.sql", import.meta.url), "utf8"));
  await pool.query("INSERT INTO users(id) VALUES('customer'),('poor-customer'),('settled-customer'),('cancel-customer'),('cancel-race-customer'),('cancel-complete-customer'),('cancel-settled-customer'),('other-customer')");
  await pool.query("INSERT INTO llm_profiles(id,current_revision_id) VALUES('profile-1','revision-1')");
  const encrypted = await encryptLlmProfileSecret("fixture-platform-secret");
  await pool.query("INSERT INTO llm_profile_revisions(id,profile_id,provider_name,base_url,model_name,encrypted_api_key) VALUES('revision-1','profile-1','Fixture','https://llm.example.test/v1','fixture-model',$1)", [encrypted]);
  await pool.query("INSERT INTO agent_role_bindings(id,role,llm_profile_id) VALUES('binding-report','report','profile-1'),('binding-proposal','proposal_a','profile-1')");
  await pool.query("INSERT INTO ai_credit_accounts(id,user_id,available_credits) VALUES('credits-customer','customer',10),('credits-poor','poor-customer',0),('credits-settled','settled-customer',10),('credits-cancel','cancel-customer',10),('credits-cancel-race','cancel-race-customer',10),('credits-cancel-complete','cancel-complete-customer',10),('credits-cancel-settled','cancel-settled-customer',10),('credits-other','other-customer',10)");
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  if (previousLlmKey === undefined) delete process.env.LLM_PROFILE_ENCRYPTION_KEY;
  else process.env.LLM_PROFILE_ENCRYPTION_KEY = previousLlmKey;
});

test("safe runtime projection resolves only the paid Client roles with the dedicated key", async () => {
  for (const role of ["report", "proposal_a"]) {
    const resolved = await resolveClientPlatformLlmConfig(pool, role);
    assert.equal(resolved.role, role);
    assert.equal(resolved.profileId, "profile-1");
    assert.equal(resolved.revisionId, "revision-1");
    assert.equal(resolved.apiKey, "fixture-platform-secret");
    assert.equal(resolved.endpoint, "https://llm.example.test/v1/chat/completions");
  }
  await pool.query("UPDATE agent_role_bindings SET enabled=false WHERE role='proposal_a'");
  assert.equal(await resolveClientPlatformLlmConfig(pool, "proposal_a"), null);
  await pool.query("UPDATE agent_role_bindings SET enabled=true WHERE role='proposal_a'");
});

test("inference replay returns the stored result without a second reservation or settlement", async () => {
  const input = {
    userId: "customer",
    operation: "assistant_message",
    idempotencyKey: "client-request-0001",
    payload: { conversationId: "conversation-1", message: "hello" },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-1",
  };
  const started = await beginClientAiInference(pool, input);
  assert.equal(started.state, "started");
  assert.equal((await pool.query("SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'")).rows[0].available_credits, "8");
  await assert.rejects(beginClientAiInference(pool, input), (error) => error?.code === "AI_REQUEST_IN_PROGRESS");

  const stored = { text: "answer", message: { id: "assistant-1" } };
  await completeClientAiInference(pool, {
    requestId: started.requestId,
    reservationId: started.reservationId,
    idempotencyKey: input.idempotencyKey,
    correlationRequestId: "request-1",
    result: stored,
    trustedUsage: {
      source: "provider_metering",
      providerRequestId: "provider-request-1",
      usageId: "provider-request-1",
      inputTokens: 10,
      outputTokens: 10,
    },
  });
  const replay = await beginClientAiInference(pool, input);
  assert.deepEqual(replay, { state: "succeeded", result: stored });
  assert.deepEqual(await readClientAiInferenceReplay(pool, {
    userId: input.userId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  }), { state: "succeeded", result: stored });
  const balance = (await pool.query("SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'")).rows[0];
  assert.deepEqual(balance, { available_credits: "9", reserved_credits: "0" });
  assert.equal((await pool.query("SELECT count(*)::int count FROM ai_credit_reservations")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int count FROM ai_credit_ledger_entries WHERE entry_type='settle'")).rows[0].count, 1);
});

test("failed inference releases the reservation and a replay never becomes a fresh provider call", async () => {
  const input = {
    userId: "customer",
    operation: "strategy_generation",
    idempotencyKey: "client-request-0002",
    payload: { conversationId: "conversation-2", brief: { name: "safe" } },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-2",
  };
  const started = await beginClientAiInference(pool, input);
  await failClientAiInference(pool, {
    requestId: started.requestId,
    reservationId: started.reservationId,
    idempotencyKey: input.idempotencyKey,
    correlationRequestId: "request-2",
    errorCode: "AI_GENERATION_FAILED",
    errorMessage: "AI 策略生成暂时不可用，请稍后使用新的请求重试",
    errorStatus: 502,
  });
  await assert.rejects(beginClientAiInference(pool, input), (error) => error?.code === "AI_GENERATION_FAILED" && error?.status === 502);
  const balance = (await pool.query("SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'")).rows[0];
  assert.deepEqual(balance, { available_credits: "9", reserved_credits: "0" });
});

test("cancelling an owned processing inference releases once and late success cannot reopen it", async () => {
  const input = {
    userId: "cancel-customer",
    operation: "assistant_message",
    idempotencyKey: "client-request-cancel-0001",
    payload: { conversationId: "conversation-cancel", message: "stop this" },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-cancel",
  };
  const started = await beginClientAiInference(pool, input);

  await assert.rejects(cancelClientAiInference(pool, {
    userId: "other-customer",
    inferenceRequestId: started.requestId,
    requestId: "cross-tenant-cancel",
  }), (error) => error?.code === "AI_REQUEST_NOT_FOUND" && error?.status === 404);

  assert.deepEqual(await cancelClientAiInference(pool, {
    userId: input.userId,
    inferenceRequestId: started.requestId,
    requestId: "cancel-owned",
  }), {
    id: started.requestId,
    state: "cancelled",
    creditsDisposition: "released",
    created: true,
  });
  assert.deepEqual(await cancelClientAiInference(pool, {
    userId: input.userId,
    inferenceRequestId: started.requestId,
    requestId: "cancel-owned-replay",
  }), {
    id: started.requestId,
    state: "cancelled",
    creditsDisposition: "released",
    created: false,
  });

  assert.deepEqual(
    (await pool.query("SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id=$1", [input.userId])).rows[0],
    { available_credits: "10", reserved_credits: "0" },
  );
  assert.equal((await pool.query(
    "SELECT count(*)::int count FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type='release'",
    [started.reservationId],
  )).rows[0].count, 1);
  await assert.rejects(completeClientAiInference(pool, {
    requestId: started.requestId,
    reservationId: started.reservationId,
    idempotencyKey: input.idempotencyKey,
    correlationRequestId: "late-provider-result",
    result: { text: "must not persist" },
    trustedUsage: {
      source: "provider_metering",
      providerRequestId: "provider-cancelled-late",
      usageId: "provider-cancelled-late",
      inputTokens: 10,
      outputTokens: 5,
    },
  }), (error) => error?.code === "AI_REQUEST_CANCELLED");
  assert.equal((await pool.query(
    "SELECT count(*)::int count FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type='settle'",
    [started.reservationId],
  )).rows[0].count, 0);
});

test("a completed inference wins a later cancel without refunding settled Credits", async () => {
  const input = {
    userId: "cancel-complete-customer",
    operation: "assistant_message",
    idempotencyKey: "client-request-complete-first",
    payload: { conversationId: "conversation-complete", message: "finish this" },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-complete-first",
  };
  const started = await beginClientAiInference(pool, input);
  await completeClientAiInference(pool, {
    requestId: started.requestId,
    reservationId: started.reservationId,
    idempotencyKey: input.idempotencyKey,
    correlationRequestId: "complete-before-cancel",
    result: { text: "completed" },
    trustedUsage: {
      source: "provider_metering",
      providerRequestId: "provider-complete-first",
      usageId: "provider-complete-first",
      inputTokens: 10,
      outputTokens: 5,
    },
  });
  assert.deepEqual(await cancelClientAiInference(pool, {
    userId: input.userId,
    inferenceRequestId: started.requestId,
    requestId: "cancel-after-complete",
  }), {
    id: started.requestId,
    state: "succeeded",
    creditsDisposition: "settled",
  });
  assert.deepEqual(
    (await pool.query("SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id=$1", [input.userId])).rows[0],
    { available_credits: "9", reserved_credits: "0" },
  );
});

test("cancel and completion race has exactly one terminal Credits disposition", async () => {
  const input = {
    userId: "cancel-race-customer",
    operation: "assistant_message",
    idempotencyKey: "client-request-cancel-race",
    payload: { conversationId: "conversation-race", message: "race" },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-cancel-race",
  };
  const started = await beginClientAiInference(pool, input);
  const [cancelled, completed] = await Promise.allSettled([
    cancelClientAiInference(pool, {
      userId: input.userId,
      inferenceRequestId: started.requestId,
      requestId: "cancel-race",
    }),
    completeClientAiInference(pool, {
      requestId: started.requestId,
      reservationId: started.reservationId,
      idempotencyKey: input.idempotencyKey,
      correlationRequestId: "complete-race",
      result: { text: "race result" },
      trustedUsage: {
        source: "provider_metering",
        providerRequestId: "provider-cancel-race",
        usageId: "provider-cancel-race",
        inputTokens: 10,
        outputTokens: 5,
      },
    }),
  ]);
  assert.ok(cancelled.status === "fulfilled" || completed.status === "fulfilled");
  const entries = (await pool.query(
    "SELECT entry_type FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type IN ('release','settle') ORDER BY entry_type",
    [started.reservationId],
  )).rows.map((row) => row.entry_type);
  assert.equal(entries.length, 1);
  assert.ok(entries[0] === "release" || entries[0] === "settle");
  const request = (await pool.query("SELECT status,error_code FROM client_ai_inference_requests WHERE id=$1", [started.requestId])).rows[0];
  assert.ok(
    (request.status === "failed" && request.error_code === "AI_REQUEST_CANCELLED" && entries[0] === "release")
    || (request.status === "succeeded" && request.error_code === null && entries[0] === "settle"),
  );
});

test("a settled processing anomaly cannot be presented as a successful cancellation", async () => {
  const input = {
    userId: "cancel-settled-customer",
    operation: "assistant_message",
    idempotencyKey: "client-request-cancel-settled",
    payload: { conversationId: "conversation-cancel-settled", message: "review" },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-cancel-settled",
  };
  const started = await beginClientAiInference(pool, input);
  await settleAiCreditReservation(pool, {
    reservationId: started.reservationId,
    idempotencyKey: `client-ai:${started.requestId}:settle`,
    requestId: "settled-before-cancel",
    costModelVersion: "token-cost-v1",
    trustedUsage: {
      source: "provider_metering",
      providerRequestId: "provider-cancel-settled",
      usageId: "provider-cancel-settled",
      inputTokens: 10,
      outputTokens: 5,
    },
  });
  await assert.rejects(cancelClientAiInference(pool, {
    userId: input.userId,
    inferenceRequestId: started.requestId,
    requestId: "cancel-settled-anomaly",
  }), (error) => error?.code === "AI_RECONCILIATION_REQUIRED" && error?.status === 409);
  assert.equal((await pool.query(
    "SELECT count(*)::int count FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type='release'",
    [started.reservationId],
  )).rows[0].count, 0);
});

test("a stale provider crash is reconciled once and the same key can never call or settle again", async () => {
  const input = {
    userId: "customer",
    operation: "assistant_message",
    idempotencyKey: "client-request-crashed",
    payload: { conversationId: "conversation-crashed", message: "hello" },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-crashed",
  };
  const started = await beginClientAiInference(pool, input);
  await pool.query(
    "UPDATE ai_credit_reservations SET expires_at=now() - interval '1 second' WHERE id=$1",
    [started.reservationId],
  );

  assert.deepEqual(await reconcileExpiredClientAiInferences(pool, {
    userId: input.userId,
    requestId: "reconcile-crashed",
  }), { reconciled: 1, released: 1, requiresReview: 0 });
  assert.deepEqual(await reconcileExpiredClientAiInferences(pool, {
    userId: input.userId,
    requestId: "reconcile-crashed-again",
  }), { reconciled: 0, released: 0, requiresReview: 0 });

  const state = (await pool.query(
    "SELECT status,error_code,error_status FROM client_ai_inference_requests WHERE id=$1",
    [started.requestId],
  )).rows[0];
  assert.deepEqual(state, {
    status: "failed",
    error_code: "AI_REQUEST_STALE_RELEASED",
    error_status: 409,
  });
  assert.deepEqual(
    (await pool.query("SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'")).rows[0],
    { available_credits: "9", reserved_credits: "0" },
  );
  assert.equal((await pool.query(
    "SELECT count(*)::int count FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type='release'",
    [started.reservationId],
  )).rows[0].count, 1);

  await assert.rejects(readClientAiInferenceReplay(pool, {
    userId: input.userId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  }), (error) => error?.code === "AI_REQUEST_STALE_RELEASED" && error?.status === 409);
  await assert.rejects(beginClientAiInference(pool, input), (error) => error?.code === "AI_REQUEST_STALE_RELEASED");

  // Even a late provider success from the crashed process cannot reopen or charge this request.
  await assert.rejects(completeClientAiInference(pool, {
    requestId: started.requestId,
    reservationId: started.reservationId,
    idempotencyKey: input.idempotencyKey,
    correlationRequestId: "provider-returned-too-late",
    result: { text: "late answer" },
    trustedUsage: {
      source: "provider_metering",
      providerRequestId: "provider-request-crashed",
      usageId: "provider-request-crashed",
      inputTokens: 10,
      outputTokens: 10,
    },
  }), (error) => error?.code === "AI_REQUEST_STALE_RELEASED");
  assert.equal((await pool.query(
    "SELECT count(*)::int count FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type='settle'",
    [started.reservationId],
  )).rows[0].count, 0);
});

test("an anomalous settled processing request is terminally flagged and is never refunded or reopened", async () => {
  const input = {
    userId: "settled-customer",
    operation: "strategy_generation",
    idempotencyKey: "client-request-settled-crash",
    payload: { conversationId: "conversation-settled", brief: { name: "review" } },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-settled-crash",
  };
  const started = await beginClientAiInference(pool, input);
  await settleAiCreditReservation(pool, {
    reservationId: started.reservationId,
    idempotencyKey: `client-ai:${started.requestId}:settle`,
    requestId: "settled-without-result",
    costModelVersion: "token-cost-v1",
    trustedUsage: {
      source: "provider_metering",
      providerRequestId: "provider-request-settled-crash",
      usageId: "provider-request-settled-crash",
      inputTokens: 10,
      outputTokens: 10,
    },
  });
  await pool.query(
    "UPDATE ai_credit_reservations SET expires_at=now() - interval '1 second' WHERE id=$1",
    [started.reservationId],
  );

  assert.deepEqual(await reconcileExpiredClientAiInferences(pool, {
    userId: input.userId,
    requestId: "reconcile-settled-crash",
  }), { reconciled: 1, released: 0, requiresReview: 1 });
  await assert.rejects(beginClientAiInference(pool, input), (error) => (
    error?.code === "AI_RECONCILIATION_REQUIRED" && error?.status === 409
  ));
  assert.deepEqual(
    (await pool.query("SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='settled-customer'")).rows[0],
    { available_credits: "9", reserved_credits: "0" },
  );
  assert.equal((await pool.query(
    "SELECT count(*)::int count FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type='release'",
    [started.reservationId],
  )).rows[0].count, 0);
});

test("insufficient Credits fails atomically with a user-facing payment-required error", async () => {
  await assert.rejects(beginClientAiInference(pool, {
    userId: "poor-customer",
    operation: "assistant_message",
    idempotencyKey: "client-request-poor",
    payload: { conversationId: "conversation-poor", message: "hello" },
    modelRevisionId: "revision-1",
    estimatedCredits: 2n,
    requestId: "request-poor",
  }), (error) => error?.code === "AI_CREDITS_INSUFFICIENT" && error?.status === 402);
  assert.equal((await pool.query("SELECT count(*)::int count FROM client_ai_inference_requests WHERE user_id='poor-customer'")).rows[0].count, 0);
});
