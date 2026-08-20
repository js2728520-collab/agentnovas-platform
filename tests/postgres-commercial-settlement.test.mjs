import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { mutateAiCredits, releaseAiCreditReservation, reserveAiCredits, settleAiCreditReservation } from "../lib/ai-credit-service.ts";
import { createMembershipOrder, decideMembershipOrder, recordMembershipPaymentEvidence, submitMembershipOrder } from "../lib/commercial-membership-service.ts";
import { decidePerformanceAssessment, decidePerformancePayment, generatePerformanceStatement, recordPerformancePaymentEvidence } from "../lib/performance-fee-service.ts";

const databaseUrl=process.env.TEST_DATABASE_URL||"postgresql://127.0.0.1/postgres";
const schema=`commercial_settlement_${process.pid}_${Date.now()}`;
const admin=new pg.Pool({connectionString:databaseUrl,max:2});
const pool=new pg.Pool({connectionString:databaseUrl,max:8,options:`-c search_path=${schema}`});

test.before(async()=>{
  assert.match(schema,/^[a-z0-9_]+$/);await admin.query(`CREATE SCHEMA "${schema}"`);
  for(const name of ["0000_business_schema.sql","0007_strategy_runtime.sql","0015_riverton_three_app_rbac_wallet.sql","0022_ledger_approval_invariants.sql","0023_commercial_membership_settlement.sql"]){
    await pool.query(await readFile(new URL(`../postgres/migrations/${name}`,import.meta.url),"utf8"));
  }
  await pool.query(`INSERT INTO organizations(id,type,name) VALUES ('org','headquarters','Org');
    INSERT INTO users(id,email,password_hash,role,organization_id,status) VALUES
      ('customer','customer@example.test','x','customer','org','active'),
      ('maker','maker@example.test','x','finance','org','active'),
      ('checker','checker@example.test','x','admin','org','active'),
      ('checker2','checker2@example.test','x','admin','org','active');
    INSERT INTO commercial_legal_document_versions(id,document_type,version,content_sha256,status,effective_at) VALUES
      ('terms-v1','terms',1,repeat('a',64),'active','2026-01-01'),
      ('privacy-v1','privacy',1,repeat('b',64),'active','2026-01-01'),
      ('risk-v1','risk_disclosure',1,repeat('c',64),'active','2026-01-01');`);
});
test.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});

test("legal gate, price snapshot and maker-checker approval are idempotent",async()=>{
  await assert.rejects(createMembershipOrder(pool,{userId:"customer",planVersionId:"membership_monthly_v1",acceptedDocumentVersionIds:["terms-v1"],idempotencyKey:"bad",requestId:"bad"}),/必须同意/);
  const order=await createMembershipOrder(pool,{userId:"customer",planVersionId:"membership_monthly_v1",acceptedDocumentVersionIds:["terms-v1","privacy-v1","risk-v1"],idempotencyKey:"order-1",requestId:"request-order-1"});
  assert.equal(order.price_amount,"28.000000000000000000");
  await recordMembershipPaymentEvidence(pool,{orderId:order.id,actorUserId:"maker",evidenceKind:"bank_transfer",reference:"SECRET-12345678",amount:"28",currency:"USDT",occurredAt:"2026-08-20T00:00:00Z"});
  assert.equal((await pool.query(`SELECT reference_masked FROM commercial_payment_evidence`)).rows[0].reference_masked,"********5678");
  await submitMembershipOrder(pool,order.id,"maker");
  await assert.rejects(decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"maker",decision:"approve",note:"self",idempotencyKey:"self",requestId:"self"}),/申请人与审批人必须不同/);
  const approved=await decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"checker",decision:"approve",note:"verified",idempotencyKey:"approve-1",requestId:"request-approve-1"});
  assert.equal(approved.status,"approved");
  assert.equal((await pool.query(`SELECT count(*)::int count FROM memberships WHERE customer_id='customer'`)).rows[0].count,1);
  assert.equal((await pool.query(`SELECT available_credits::text FROM ai_credit_accounts WHERE user_id='customer'`)).rows[0].available_credits,"1000");
  assert.equal((await pool.query(`SELECT count(*)::int count FROM ledger_transactions WHERE source_id=$1`,[order.id])).rows[0].count,1);
  const replay=await decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"checker",decision:"approve",note:"verified",idempotencyKey:"approve-1",requestId:"request-approve-1"});
  assert.equal(replay.replayed,true);
  await assert.rejects(pool.query(`UPDATE ledger_transactions SET metadata_json='{}' WHERE source_id=$1`,[order.id]),/LEDGER_APPEND_ONLY/);
});

test("AI credits never become negative and idempotent entries preserve conservation",async()=>{
  const client=await pool.connect();try{await client.query("BEGIN");await assert.rejects(mutateAiCredits(client,{userId:"customer",type:"reserve",availableDelta:BigInt(-2000),reservedDelta:BigInt(2000),sourceType:"inference",sourceId:"too-large",idempotencyKey:"too-large",requestId:"too-large"}),/AI_CREDIT_INSUFFICIENT/);await client.query("ROLLBACK");}finally{client.release();}
  const account=(await pool.query(`SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'`)).rows[0];
  assert.deepEqual(account,{available_credits:"1000",reserved_credits:"0"});
  const client2=await pool.connect();try{await client2.query("BEGIN");const reserved=await reserveAiCredits(client2,{userId:"customer",credits:BigInt(100),sourceType:"inference",sourceId:"call-1",idempotencyKey:"reserve-1",requestId:"reserve-1",expiresAt:"2026-08-21"});await settleAiCreditReservation(client2,{reservationId:reserved.reservationId,actualCredits:BigInt(60),idempotencyKey:"settle-1",requestId:"settle-1",costModelVersion:"token-cost-v1",usage:{inputTokens:1,outputTokens:1}});const released=await reserveAiCredits(client2,{userId:"customer",credits:BigInt(50),sourceType:"inference",sourceId:"call-2",idempotencyKey:"reserve-2",requestId:"reserve-2",expiresAt:"2026-08-21"});await releaseAiCreditReservation(client2,{reservationId:released.reservationId,idempotencyKey:"release-2",requestId:"release-2"});await client2.query("COMMIT");}catch(error){await client2.query("ROLLBACK");throw error;}finally{client2.release();}
  assert.deepEqual((await pool.query(`SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'`)).rows[0],{available_credits:"940",reserved_credits:"0"});
});

test("concurrent membership checkers cannot duplicate activation, credits or ledger",async()=>{
  const order=await createMembershipOrder(pool,{userId:"customer",planVersionId:"membership_quarterly_v1",acceptedDocumentVersionIds:["terms-v1","privacy-v1","risk-v1"],idempotencyKey:"order-concurrent",requestId:"request-concurrent"});
  await recordMembershipPaymentEvidence(pool,{orderId:order.id,actorUserId:"maker",evidenceKind:"bank_transfer",reference:"CONCURRENT-1234",amount:"58",currency:"USDT",occurredAt:"2026-08-20T00:00:00Z"});
  await submitMembershipOrder(pool,order.id,"maker");
  const results=await Promise.allSettled([
    decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"checker",decision:"approve",note:"ok",idempotencyKey:"concurrent-a",requestId:"concurrent-a"}),
    decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"checker2",decision:"approve",note:"ok",idempotencyKey:"concurrent-b",requestId:"concurrent-b"}),
  ]);
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  assert.equal((await pool.query(`SELECT count(*)::int count FROM ledger_transactions WHERE source_id=$1`,[order.id])).rows[0].count,1);
  assert.equal((await pool.query(`SELECT count(*)::int count FROM membership_entitlement_events WHERE order_id=$1`,[order.id])).rows[0].count,1);
});

test("weekly performance fee uses three paper strategies, unpaid blocking and paid HWM",async()=>{
  for(const [index,pnl] of ["100","200","-50"].entries()){
    const deployment=`deployment-${index}`,cycle=`cycle-${index}`;
    await pool.query(`INSERT INTO strategy_deployments(id,owner_user_id,strategy_id,strategy_version_id,exchange_account_id,mode,status,validation_label,idempotency_key)
      VALUES($1,'customer',$2,$3,$4,'paper','active','STANDARD_VERIFIED',$5)`,[deployment,`strategy-${index}`,`version-${index}`,`exchange-${index}`,`deployment-${index}`]);
    await pool.query(`INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,decision_json,trace_id,started_at)
      VALUES($1,$2,1,1,'2026-08-07','2026-08-08','completed','{}','trace','2026-08-07')`,[cycle,deployment]);
    await pool.query(`INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at)
      VALUES($1,$2,'long','closed',1,100,101,$3,$3,$4,'2026-08-07','2026-08-08')`,[`position-${index}`,deployment,cycle,pnl]);
  }
  const statement=await generatePerformanceStatement(pool,{userId:"customer",strategyIds:["strategy-0","strategy-1","strategy-2"],weekStart:"2026-08-03T00:00:00Z",weekEnd:"2026-08-10T00:00:00Z",generatedByUserId:"maker",requestId:"statement-1"});
  assert.equal(statement.fee_amount,"50.000000000000000000");
  await decidePerformanceAssessment(pool,{statementId:statement.id,reviewerUserId:"checker",decision:"approve",note:"approved",idempotencyKey:"statement-approve"});
  await assert.rejects(generatePerformanceStatement(pool,{userId:"customer",strategyIds:["strategy-0","strategy-1","strategy-2"],weekStart:"2026-08-10T00:00:00Z",weekEnd:"2026-08-17T00:00:00Z",generatedByUserId:"maker",requestId:"statement-blocked"}),/前序结算单/);
  await recordPerformancePaymentEvidence(pool,{statementId:statement.id,actorUserId:"checker",evidenceKind:"bank_transfer",reference:"PAYMENT-1234",amount:"50",currency:"USDT",occurredAt:"2026-08-20T00:00:00Z"});
  await assert.rejects(decidePerformancePayment(pool,{statementId:statement.id,reviewerUserId:"checker",decision:"approve",note:"self",idempotencyKey:"payment-self"}),/付款记录人与审批人必须不同/);
  const paid=await decidePerformancePayment(pool,{statementId:statement.id,reviewerUserId:"checker2",decision:"approve",note:"verified",idempotencyKey:"payment-approved"});
  assert.equal(paid.status,"paid");
  assert.equal((await pool.query(`SELECT high_water_mark::text FROM performance_fee_high_water_marks WHERE user_id='customer'`)).rows[0].high_water_mark,"250.000000000000000000");
  for(const index of [0,1,2]){
    const cycle=`loss-cycle-${index}`;
    await pool.query(`INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,decision_json,trace_id,started_at)
      VALUES($1,$2,2,1,'2026-08-14','2026-08-15','completed','{}','loss-trace','2026-08-14')`,[cycle,`deployment-${index}`]);
    await pool.query(`INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at)
      VALUES($1,$2,'long','closed',1,100,90,$3,$3,-100,'2026-08-14','2026-08-15')`,[`loss-position-${index}`,`deployment-${index}`,cycle]);
  }
  const loss=await generatePerformanceStatement(pool,{userId:"customer",strategyIds:["strategy-0","strategy-1","strategy-2"],weekStart:"2026-08-10T00:00:00Z",weekEnd:"2026-08-17T00:00:00Z",generatedByUserId:"maker",requestId:"statement-loss"});
  assert.equal(loss.fee_amount,"0.000000000000000000");
  assert.equal(loss.loss_carry,"300.000000000000000000");
  assert.equal((await generatePerformanceStatement(pool,{userId:"customer",strategyIds:["strategy-0","strategy-1","strategy-2"],weekStart:"2026-08-10T00:00:00Z",weekEnd:"2026-08-17T00:00:00Z",generatedByUserId:"maker",requestId:"statement-loss-replay"})).replayed,true);
  assert.equal((await decidePerformanceAssessment(pool,{statementId:loss.id,reviewerUserId:"checker",decision:"approve",note:"no fee",idempotencyKey:"loss-approved"})).status,"no_fee");
  assert.equal((await pool.query(`SELECT high_water_mark::text FROM performance_fee_high_water_marks WHERE user_id='customer'`)).rows[0].high_water_mark,"250.000000000000000000");
});
