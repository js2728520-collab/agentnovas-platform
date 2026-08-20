import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type CreditMutation = "grant" | "reserve" | "settle" | "release" | "adjust";

export async function mutateAiCredits(client: PoolClient, input: {
  userId: string;
  type: CreditMutation;
  availableDelta: bigint;
  reservedDelta: bigint;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  requestId: string;
  actorUserId?: string;
  reservationId?: string;
  costModelVersion?: string;
  usage?: Record<string, unknown>;
}) {
  const zero=BigInt(0);
  const valid=input.type==="grant" ? input.availableDelta>zero&&input.reservedDelta===zero
    : input.type==="reserve" ? input.availableDelta<zero&&input.reservedDelta===-input.availableDelta
    : input.type==="settle" ? input.availableDelta>=zero&&input.reservedDelta<zero&&input.availableDelta+input.reservedDelta<=zero
    : input.type==="release" ? input.availableDelta>zero&&input.reservedDelta===-input.availableDelta
    : input.reservedDelta===zero&&input.availableDelta!==zero;
  if(!valid) throw new Error("AI_CREDIT_MUTATION_INVALID");
  const prior = await client.query<{ id: string; balance_available: string; balance_reserved: string }>(
    `SELECT id, balance_available::text, balance_reserved::text FROM ai_credit_ledger_entries WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  if (prior.rows[0]) return { entryId: prior.rows[0].id, available: prior.rows[0].balance_available, reserved: prior.rows[0].balance_reserved, created: false };
  await client.query(`INSERT INTO ai_credit_accounts (id, user_id) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`, [randomUUID(), input.userId]);
  const account = await client.query<{ id: string; available_credits: string; reserved_credits: string }>(`
    SELECT id, available_credits::text, reserved_credits::text FROM ai_credit_accounts WHERE user_id=$1 FOR UPDATE
  `, [input.userId]);
  if (!account.rows[0]) throw new Error("AI_CREDIT_ACCOUNT_MISSING");
  const available = BigInt(account.rows[0].available_credits) + input.availableDelta;
  const reserved = BigInt(account.rows[0].reserved_credits) + input.reservedDelta;
  if (available < BigInt(0) || reserved < BigInt(0)) throw new Error("AI_CREDIT_INSUFFICIENT");
  await client.query(`UPDATE ai_credit_accounts SET available_credits=$2, reserved_credits=$3, version=version+1, updated_at=now() WHERE id=$1`,
    [account.rows[0].id, available.toString(), reserved.toString()]);
  const entryId = randomUUID();
  await client.query(`
    INSERT INTO ai_credit_ledger_entries
      (id,account_id,entry_type,available_delta,reserved_delta,balance_available,balance_reserved,
       source_type,source_id,reservation_id,cost_model_version,usage_json,idempotency_key,request_id,created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
  `, [entryId, account.rows[0].id, input.type, input.availableDelta.toString(), input.reservedDelta.toString(),
    available.toString(), reserved.toString(), input.sourceType, input.sourceId, input.reservationId ?? null,
    input.costModelVersion ?? null, input.usage ? JSON.stringify(input.usage) : null,
    input.idempotencyKey, input.requestId, input.actorUserId ?? null]);
  return { entryId, available: available.toString(), reserved: reserved.toString(), created: true };
}

export async function reserveAiCredits(client:PoolClient,input:{userId:string;credits:bigint;sourceType:string;sourceId:string;idempotencyKey:string;requestId:string;expiresAt:string;actorUserId?:string}){
  if(input.credits<=BigInt(0))throw new Error("AI_CREDIT_AMOUNT_INVALID");
  const existing=await client.query<{id:string}>(`SELECT id FROM ai_credit_reservations WHERE idempotency_key=$1 FOR UPDATE`,[input.idempotencyKey]);
  if(existing.rows[0])return {reservationId:existing.rows[0].id,created:false};
  const account=await client.query<{id:string}>(`SELECT id FROM ai_credit_accounts WHERE user_id=$1`,[input.userId]);
  if(!account.rows[0]){await client.query(`INSERT INTO ai_credit_accounts(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`,[randomUUID(),input.userId]);}
  const locked=await client.query<{id:string}>(`SELECT id FROM ai_credit_accounts WHERE user_id=$1 FOR UPDATE`,[input.userId]);
  const reservationId=randomUUID();
  await client.query(`INSERT INTO ai_credit_reservations(id,account_id,estimated_credits,idempotency_key,expires_at) VALUES($1,$2,$3,$4,$5)`,[reservationId,locked.rows[0].id,input.credits.toString(),input.idempotencyKey,input.expiresAt]);
  await mutateAiCredits(client,{userId:input.userId,type:"reserve",availableDelta:-input.credits,reservedDelta:input.credits,sourceType:input.sourceType,sourceId:input.sourceId,idempotencyKey:`${input.idempotencyKey}:ledger`,requestId:input.requestId,actorUserId:input.actorUserId,reservationId});
  return {reservationId,created:true};
}

export async function settleAiCreditReservation(client:PoolClient,input:{reservationId:string;actualCredits:bigint;idempotencyKey:string;requestId:string;actorUserId?:string;costModelVersion:string;usage:Record<string,unknown>}){
  const reservation=await client.query<{account_id:string;estimated_credits:string;status:string;user_id:string}>(`SELECT r.account_id,r.estimated_credits::text,r.status,a.user_id FROM ai_credit_reservations r JOIN ai_credit_accounts a ON a.id=r.account_id WHERE r.id=$1 FOR UPDATE`,[input.reservationId]);
  const row=reservation.rows[0];if(!row)throw new Error("AI_CREDIT_RESERVATION_NOT_FOUND");
  if(row.status==="settled")return {reservationId:input.reservationId,created:false};
  if(row.status!=="reserved")throw new Error("AI_CREDIT_RESERVATION_STATE_CONFLICT");
  const estimated=BigInt(row.estimated_credits);if(input.actualCredits<BigInt(0)||input.actualCredits>estimated)throw new Error("AI_CREDIT_RESERVATION_EXCEEDED");
  await mutateAiCredits(client,{userId:row.user_id,type:"settle",availableDelta:estimated-input.actualCredits,reservedDelta:-estimated,sourceType:"ai_credit_reservation",sourceId:input.reservationId,idempotencyKey:input.idempotencyKey,requestId:input.requestId,actorUserId:input.actorUserId,reservationId:input.reservationId,costModelVersion:input.costModelVersion,usage:input.usage});
  await client.query(`UPDATE ai_credit_reservations SET status='settled',settled_credits=$2,version=version+1,updated_at=now() WHERE id=$1`,[input.reservationId,input.actualCredits.toString()]);
  return {reservationId:input.reservationId,created:true};
}

export async function releaseAiCreditReservation(client:PoolClient,input:{reservationId:string;idempotencyKey:string;requestId:string;actorUserId?:string}){
  const reservation=await client.query<{estimated_credits:string;status:string;user_id:string}>(`SELECT r.estimated_credits::text,r.status,a.user_id FROM ai_credit_reservations r JOIN ai_credit_accounts a ON a.id=r.account_id WHERE r.id=$1 FOR UPDATE`,[input.reservationId]);
  const row=reservation.rows[0];if(!row)throw new Error("AI_CREDIT_RESERVATION_NOT_FOUND");
  if(row.status==="released")return {reservationId:input.reservationId,created:false};
  if(row.status!=="reserved")throw new Error("AI_CREDIT_RESERVATION_STATE_CONFLICT");
  const credits=BigInt(row.estimated_credits);
  await mutateAiCredits(client,{userId:row.user_id,type:"release",availableDelta:credits,reservedDelta:-credits,sourceType:"ai_credit_reservation",sourceId:input.reservationId,idempotencyKey:input.idempotencyKey,requestId:input.requestId,actorUserId:input.actorUserId,reservationId:input.reservationId});
  await client.query(`UPDATE ai_credit_reservations SET status='released',version=version+1,updated_at=now() WHERE id=$1`,[input.reservationId]);
  return {reservationId:input.reservationId,created:true};
}
