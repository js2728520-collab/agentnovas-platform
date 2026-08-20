import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { mutateAiCredits,releaseAiCreditReservation,reserveAiCredits,settleAiCreditReservation } from "../lib/ai-credit-service.ts";
import { createMembershipOrder,decideMembershipOrder,recordMembershipPaymentEvidence,submitMembershipOrder } from "../lib/commercial-membership-service.ts";
import { ensurePlatformLedgerAccount,postCommercialLedgerTransaction } from "../lib/commercial-ledger-service.ts";
import { decidePerformanceAssessment,decidePerformancePayment,generatePerformanceStatement,recordPerformancePaymentEvidence } from "../lib/performance-fee-service.ts";

const databaseUrl=process.env.TEST_DATABASE_URL||"postgresql://127.0.0.1/postgres";
const schema=`commercial_settlement_${process.pid}_${Date.now()}`;
const admin=new pg.Pool({connectionString:databaseUrl,max:2});
const pool=new pg.Pool({connectionString:databaseUrl,max:8,options:`-c search_path=${schema}`});
const legalIds=["entity-v1","jurisdiction-v1","privacy-v1","terms-v1","risk-v1","fee-opinion-v1","refund-v1"];
const officialScope=async()=>({strategyIds:["strategy-0","strategy-1","strategy-2"],scopeVersion:"official-three-card-v1",source:"official_three_card_portfolio"});

test.before(async()=>{
  assert.match(schema,/^[a-z0-9_]+$/);await admin.query(`CREATE SCHEMA "${schema}"`);
  const migrationNames=(await readdir(new URL("../postgres/migrations/",import.meta.url))).filter(name=>/^00(?:0\d|1\d|20)_.*\.sql$/.test(name)).sort();
  for(const name of [...migrationNames,"0022_ledger_approval_invariants.sql","0023_commercial_membership_settlement.sql"])
    await pool.query(await readFile(new URL(`../postgres/migrations/${name}`,import.meta.url),"utf8"));
  await pool.query(`INSERT INTO organizations(id,type,name) VALUES('org','headquarters','Org');
    INSERT INTO users(id,email,password_hash,role,organization_id,status) VALUES
      ('customer','customer@example.test','x','customer','org','active'),('customer2','customer2@example.test','x','customer','org','active'),
      ('maker','maker@example.test','x','finance','org','active'),('checker','checker@example.test','x','admin','org','active'),('checker2','checker2@example.test','x','admin','org','active');
    INSERT INTO commercial_legal_document_versions(id,document_type,version,content_sha256,status,approved_by_user_id,approved_at,effective_at) VALUES
      ('entity-v1','service_entity',1,repeat('a',64),'active','checker','2026-01-01','2026-01-01'),
      ('jurisdiction-v1','jurisdiction',1,repeat('b',64),'active','checker','2026-01-01','2026-01-01'),
      ('privacy-v1','privacy',1,repeat('c',64),'active','checker','2026-01-01','2026-01-01'),
      ('terms-v1','terms',1,repeat('d',64),'active','checker','2026-01-01','2026-01-01'),
      ('risk-v1','risk_disclosure',1,repeat('e',64),'active','checker','2026-01-01','2026-01-01'),
      ('fee-opinion-v1','simulated_performance_fee_opinion',1,repeat('f',64),'active','checker','2026-01-01','2026-01-01'),
      ('refund-v1','refund_policy',1,repeat('0',64),'active','checker','2026-01-01','2026-01-01');`);
});
test.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});

async function readyOrder(planVersionId,key,{evidenceActor="maker",submitter="maker",userId="customer"}={}){
  const order=await createMembershipOrder(pool,{userId,planVersionId,acceptedDocumentVersionIds:legalIds,idempotencyKey:`${key}-create`,requestId:`${key}-create`});
  const amount=planVersionId.includes("monthly")?"28":planVersionId.includes("quarterly")?"58":planVersionId.includes("annual")?"198":"588";
  await recordMembershipPaymentEvidence(pool,{orderId:order.id,actorUserId:evidenceActor,evidenceKind:"bank_transfer",reference:`${key}-REFERENCE-1234`,amount,currency:"USD",occurredAt:"2026-08-20T00:00:00Z",idempotencyKey:`${key}-evidence`});
  await submitMembershipOrder(pool,{orderId:order.id,actorUserId:submitter,idempotencyKey:`${key}-submit`});return order;
}

test("seven-current-document gate, USD snapshot and bound idempotency activate safely",async()=>{
  await assert.rejects(createMembershipOrder(pool,{userId:"customer",planVersionId:"membership_monthly_v1",acceptedDocumentVersionIds:legalIds.slice(0,6),idempotencyKey:"legal-bad",requestId:"legal-bad"}),/七项法务/);
  const order=await createMembershipOrder(pool,{userId:"customer",planVersionId:"membership_monthly_v1",acceptedDocumentVersionIds:legalIds,idempotencyKey:"order-create-1",requestId:"order-create-1"});
  assert.equal(order.price_currency,"USD");assert.equal(order.price_amount,"28.000000000000000000");
  assert.equal((await createMembershipOrder(pool,{userId:"customer",planVersionId:"membership_monthly_v1",acceptedDocumentVersionIds:[...legalIds].reverse(),idempotencyKey:"order-create-1",requestId:"another-trace"})).id,order.id);
  await assert.rejects(createMembershipOrder(pool,{userId:"customer2",planVersionId:"membership_monthly_v1",acceptedDocumentVersionIds:legalIds,idempotencyKey:"order-create-1",requestId:"collision"}),/已绑定其他操作/);
  await recordMembershipPaymentEvidence(pool,{orderId:order.id,actorUserId:"checker",evidenceKind:"bank_transfer",reference:"CHECKER-SECRET-1234",amount:"28",currency:"USD",occurredAt:"2026-08-20T00:00:00Z",idempotencyKey:"order-evidence-checker"});
  await recordMembershipPaymentEvidence(pool,{orderId:order.id,actorUserId:"maker",evidenceKind:"bank_transfer",reference:"MAKER-SECRET-5678",amount:"28",currency:"USD",occurredAt:"2026-08-20T00:00:00Z",idempotencyKey:"order-evidence-maker"});
  await submitMembershipOrder(pool,{orderId:order.id,actorUserId:"maker",idempotencyKey:"order-submit-1"});
  await assert.rejects(decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"maker",decision:"approve",note:"self",idempotencyKey:"order-self",requestId:"order-self"}),/提交人与审批人必须不同/);
  await assert.rejects(decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"checker",decision:"approve",note:"evidence actor",idempotencyKey:"order-evidence-actor",requestId:"order-evidence-actor"}),/凭证记录人与审批人必须不同/);
  const activated=await decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"checker2",decision:"approve",note:"verified",idempotencyKey:"order-approved",requestId:"order-approved"});
  assert.equal(activated.status,"activated");assert.equal((await pool.query(`SELECT status FROM commercial_membership_orders WHERE id=$1`,[order.id])).rows[0].status,"activated");
  assert.equal((await pool.query(`SELECT count(*)::int count FROM memberships WHERE customer_id='customer' AND status='active'`)).rows[0].count,1);
  assert.equal((await pool.query(`SELECT available_credits::text FROM ai_credit_accounts WHERE user_id='customer'`)).rows[0].available_credits,"1000");
  await assert.rejects(decideMembershipOrder(pool,{orderId:order.id,reviewerUserId:"checker",decision:"approve",note:"collision",idempotencyKey:"order-approved",requestId:"collision"}),/已绑定其他操作/);
});

test("credits settle derives cost from trusted usage and rolls back every partial mutation",async()=>{
  const client=await pool.connect();let reservationId;try{await client.query("BEGIN");const reserved=await reserveAiCredits(client,{userId:"customer",credits:BigInt(100),sourceType:"inference",sourceId:"call-1",idempotencyKey:"reserve-1",requestId:"reserve-1",expiresAt:"2026-08-21"});reservationId=reserved.reservationId;await client.query("COMMIT");}finally{client.release();}
  const settled=await settleAiCreditReservation(pool,{reservationId,idempotencyKey:"settle-1",requestId:"settle-1",costModelVersion:"token-cost-v1",trustedUsage:{source:"provider_metering",usageId:"usage-1",inputTokens:0,outputTokens:2_000_000}});assert.equal(settled.settledCredits,"60");
  await assert.rejects(settleAiCreditReservation(pool,{reservationId,idempotencyKey:"other-key",requestId:"other",costModelVersion:"token-cost-v1",trustedUsage:{source:"provider_metering",usageId:"usage-1",inputTokens:0,outputTokens:2_000_000}}),/上下文不一致/);
  const client2=await pool.connect();let rollbackReservation;try{await client2.query("BEGIN");rollbackReservation=(await reserveAiCredits(client2,{userId:"customer",credits:BigInt(50),sourceType:"inference",sourceId:"rollback",idempotencyKey:"reserve-rollback",requestId:"reserve-rollback",expiresAt:"2026-08-21"})).reservationId;await client2.query("COMMIT");}finally{client2.release();}
  await pool.query(`CREATE OR REPLACE FUNCTION fail_credit_settle() RETURNS trigger AS $$ BEGIN IF NEW.status='settled' THEN RAISE EXCEPTION 'forced settle failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_credit_settle BEFORE UPDATE ON ai_credit_reservations FOR EACH ROW EXECUTE FUNCTION fail_credit_settle();`);
  const before=(await pool.query(`SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'`)).rows[0];
  await assert.rejects(settleAiCreditReservation(pool,{reservationId:rollbackReservation,idempotencyKey:"settle-rollback",requestId:"settle-rollback",costModelVersion:"token-cost-v1",trustedUsage:{source:"provider_metering",usageId:"usage-rollback",inputTokens:0,outputTokens:1_000_000}}),/forced settle failure/);
  assert.deepEqual((await pool.query(`SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'`)).rows[0],before);
  await pool.query(`DROP TRIGGER fail_credit_settle ON ai_credit_reservations; DROP FUNCTION fail_credit_settle()`);
  const client3=await pool.connect();try{await client3.query("BEGIN");await releaseAiCreditReservation(client3,{reservationId:rollbackReservation,idempotencyKey:"release-rollback",requestId:"release-rollback"});await client3.query("COMMIT");}finally{client3.release();}
  await assert.rejects((async()=>{const c=await pool.connect();try{await c.query("BEGIN");await mutateAiCredits(c,{userId:"customer",type:"reserve",availableDelta:BigInt(-100000),reservedDelta:BigInt(100000),sourceType:"inference",sourceId:"too-large",idempotencyKey:"too-large",requestId:"too-large"});}finally{await c.query("ROLLBACK");c.release();}})(),/AI_CREDIT_INSUFFICIENT/);
});

test("posted ledger rejects every later posting",async()=>{
  const client=await pool.connect();let transactionId;try{await client.query("BEGIN");const platform=await ensurePlatformLedgerAccount(client,"platform_deposit_clearing","USDT");await client.query(`INSERT INTO ledger_accounts(id,owner_user_id,account_type,currency) VALUES('customer-available','customer','user_available','USDT') ON CONFLICT DO NOTHING`);transactionId=(await postCommercialLedgerTransaction(client,{transactionType:"correction",sourceType:"test",sourceId:"wallet-credit",currency:"USDT",idempotencyKey:"wallet-credit",requestId:"wallet-credit",createdByUserId:"checker",postings:[{accountId:platform,side:"debit",amount:"5"},{accountId:"customer-available",side:"credit",amount:"5"}],walletMutation:{userId:"customer",availableDelta:"5",frozenDelta:"0"},audit:{action:"test.wallet.credit",subjectType:"user",subjectId:"customer"},outbox:{userId:"customer",category:"wallet",templateKey:"wallet_credited",payload:{amount:"5"},dedupeKey:"wallet-credit"}})).id;await client.query("COMMIT");}finally{client.release();}
  await assert.rejects(pool.query(`INSERT INTO ledger_postings(id,transaction_id,account_id,side,amount,currency) VALUES('late-posting',$1,'customer-available','credit',1,'USDT')`,[transactionId]),/LEDGER_TRANSACTION_COMMITTED/);
  await assert.rejects(pool.query(`UPDATE ledger_transactions SET metadata_json='{}' WHERE id=$1`,[transactionId]),/LEDGER_APPEND_ONLY/);
});

test("different concurrent orders serialize on one membership row and lifetime cannot downgrade",async()=>{
  const [quarterly,annual]=await Promise.all([readyOrder("membership_quarterly_v1","quarterly"),readyOrder("membership_annual_v1","annual")]);
  const results=await Promise.all([
    decideMembershipOrder(pool,{orderId:quarterly.id,reviewerUserId:"checker",decision:"approve",note:"ok",idempotencyKey:"quarterly-approve",requestId:"quarterly-approve"}),
    decideMembershipOrder(pool,{orderId:annual.id,reviewerUserId:"checker2",decision:"approve",note:"ok",idempotencyKey:"annual-approve",requestId:"annual-approve"}),
  ]);assert.ok(results.every(result=>result.status==="activated"));assert.equal((await pool.query(`SELECT count(*)::int count FROM memberships WHERE customer_id='customer' AND status='active'`)).rows[0].count,1);
  const lifetime=await readyOrder("membership_lifetime_v1","lifetime");await decideMembershipOrder(pool,{orderId:lifetime.id,reviewerUserId:"checker",decision:"approve",note:"ok",idempotencyKey:"lifetime-approve",requestId:"lifetime-approve"});
  const finite=await readyOrder("membership_monthly_v1","finite-after-lifetime");await assert.rejects(decideMembershipOrder(pool,{orderId:finite.id,reviewerUserId:"checker2",decision:"approve",note:"no downgrade",idempotencyKey:"finite-approve",requestId:"finite-approve"}),/终身会员不得/);
});

test("only the previous complete UTC week settles server-resolved scope with HWM sequencing",async()=>{
  await pool.query(`UPDATE membership_entitlement_events SET valid_from='2026-08-01',valid_until=NULL WHERE user_id='customer'`);
  for(const [index,pnl] of ["100","200","-50"].entries()){
    const deployment=`deployment-${index}`,cycle=`cycle-${index}`;await pool.query(`INSERT INTO strategy_deployments(id,owner_user_id,strategy_id,strategy_version_id,exchange_account_id,mode,status,validation_label,idempotency_key) VALUES($1,'customer',$2,$3,$4,'paper','active','STANDARD_VERIFIED',$5)`,[deployment,`strategy-${index}`,`version-${index}`,`exchange-${index}`,deployment]);await pool.query(`INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,decision_json,trace_id,started_at) VALUES($1,$2,1,1,'2026-08-07','2026-08-08','completed','{}','trace','2026-08-07')`,[cycle,deployment]);await pool.query(`INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at) VALUES($1,$2,'long','closed',1,100,101,$3,$3,$4,'2026-08-07','2026-08-08')`,[`position-${index}`,deployment,cycle,pnl]);
  }
  await assert.rejects(generatePerformanceStatement(pool,{userId:"customer",generatedByUserId:"maker",requestId:"unresolved",idempotencyKey:"unresolved",now:new Date("2026-08-12T00:00:00Z")}),/解析器尚未接入/);
  const statement=await generatePerformanceStatement(pool,{userId:"customer",generatedByUserId:"maker",requestId:"statement-1",idempotencyKey:"statement-1",now:new Date("2026-08-12T00:00:00Z"),resolvePortfolioScope:officialScope});assert.equal(statement.week_start.toISOString(),"2026-08-03T00:00:00.000Z");assert.equal(statement.fee_amount,"40.000000000000000000");
  await pool.query(`INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at) VALUES('late-pnl','deployment-0','long','closed',1,100,101,'cycle-0','cycle-0',10,'2026-08-07','2026-08-08')`);
  await assert.rejects(decidePerformanceAssessment(pool,{statementId:statement.id,reviewerUserId:"checker",decision:"approve",note:"stale",idempotencyKey:"statement-stale"}),/数据已变化/);await pool.query(`DELETE FROM strategy_paper_positions WHERE id='late-pnl'`);
  await decidePerformanceAssessment(pool,{statementId:statement.id,reviewerUserId:"checker",decision:"approve",note:"approved",idempotencyKey:"statement-approved"});
  await assert.rejects(decidePerformanceAssessment(pool,{statementId:statement.id,reviewerUserId:"checker",decision:"reject",note:"collision",idempotencyKey:"statement-approved"}),/已绑定其他操作/);
  await assert.rejects(generatePerformanceStatement(pool,{userId:"customer",generatedByUserId:"maker",requestId:"blocked",idempotencyKey:"statement-blocked",now:new Date("2026-08-19T00:00:00Z"),resolvePortfolioScope:officialScope}),/前序结算单尚未完成/);
  await recordPerformancePaymentEvidence(pool,{statementId:statement.id,actorUserId:"checker",evidenceKind:"bank_transfer",reference:"PAYMENT-CHECKER-1234",amount:"40",currency:"USDT",occurredAt:"2026-08-20T00:00:00Z",idempotencyKey:"payment-evidence-checker"});await recordPerformancePaymentEvidence(pool,{statementId:statement.id,actorUserId:"maker",evidenceKind:"bank_transfer",reference:"PAYMENT-MAKER-5678",amount:"40",currency:"USDT",occurredAt:"2026-08-20T00:00:00Z",idempotencyKey:"payment-evidence-maker"});
  await assert.rejects(decidePerformancePayment(pool,{statementId:statement.id,reviewerUserId:"checker",decision:"approve",note:"self",idempotencyKey:"payment-self",requestId:"payment-self"}),/凭证记录人均不得/);
  const paid=await decidePerformancePayment(pool,{statementId:statement.id,reviewerUserId:"checker2",decision:"approve",note:"verified",idempotencyKey:"payment-approved",requestId:"payment-approved"});assert.equal(paid.status,"paid");assert.ok((await pool.query(`SELECT ledger_transaction_id FROM performance_fee_statements WHERE id=$1`,[statement.id])).rows[0].ledger_transaction_id);
  for(const index of [0,1,2]){const cycle=`loss-cycle-${index}`;await pool.query(`INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,decision_json,trace_id,started_at) VALUES($1,$2,2,1,'2026-08-14','2026-08-15','completed','{}','loss','2026-08-14')`,[cycle,`deployment-${index}`]);await pool.query(`INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at) VALUES($1,$2,'long','closed',1,100,90,$3,$3,-100,'2026-08-14','2026-08-15')`,[`loss-position-${index}`,`deployment-${index}`,cycle]);}
  const loss=await generatePerformanceStatement(pool,{userId:"customer",generatedByUserId:"maker",requestId:"statement-loss",idempotencyKey:"statement-loss",now:new Date("2026-08-19T00:00:00Z"),resolvePortfolioScope:officialScope});assert.equal(loss.fee_amount,"0.000000000000000000");assert.equal(loss.loss_carry,"300.000000000000000000");assert.equal((await generatePerformanceStatement(pool,{userId:"customer",generatedByUserId:"maker",requestId:"replay",idempotencyKey:"statement-loss",now:new Date("2026-08-19T00:00:00Z"),resolvePortfolioScope:officialScope})).id,loss.id);
});
