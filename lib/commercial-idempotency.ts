import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { ResearchApiError } from "./research-errors.ts";

function canonical(value:unknown):string{
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
export function canonicalPayloadHash(value:unknown){return createHash("sha256").update(canonical(value)).digest("hex");}

export type CommercialIdempotencyDescriptor={operation:string;key:string;actorUserId:string;subjectType:string;subjectId:string;resourceId?:string;stage:string;decision?:string;payload:unknown;sourceType?:string;sourceId?:string;currency?:string};

export async function claimCommercialIdempotency(client:PoolClient,input:CommercialIdempotencyDescriptor){
  const hash=canonicalPayloadHash(input.payload);
  await client.query(`INSERT INTO commercial_idempotency_records
    (operation,idempotency_key,actor_user_id,subject_type,subject_id,resource_id,stage,decision,canonical_payload_sha256,source_type,source_id,currency)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
  [input.operation,input.key,input.actorUserId,input.subjectType,input.subjectId,input.resourceId??null,input.stage,input.decision??null,hash,input.sourceType??null,input.sourceId??null,input.currency??null]);
  const result=await client.query<{actor_user_id:string;subject_type:string;subject_id:string;resource_id:string|null;stage:string;decision:string|null;canonical_payload_sha256:string;source_type:string|null;source_id:string|null;currency:string|null;status:string;response_json:unknown}>(`
    SELECT actor_user_id,subject_type,subject_id,resource_id,stage,decision,canonical_payload_sha256,source_type,source_id,currency,status,response_json
    FROM commercial_idempotency_records WHERE operation=$1 AND idempotency_key=$2 FOR UPDATE`,[input.operation,input.key]);
  const row=result.rows[0];
  const matches=row&&row.actor_user_id===input.actorUserId&&row.subject_type===input.subjectType&&row.subject_id===input.subjectId
    &&row.resource_id===(input.resourceId??null)&&row.stage===input.stage&&row.decision===(input.decision??null)
    &&row.canonical_payload_sha256===hash&&row.source_type===(input.sourceType??null)&&row.source_id===(input.sourceId??null)&&row.currency===(input.currency??null);
  if(!matches)throw new ResearchApiError("IDEMPOTENCY_KEY_COLLISION","Idempotency-Key 已绑定其他操作",409);
  return row.status==="completed"?{replayed:true,response:row.response_json}:{replayed:false,response:null};
}

export async function completeCommercialIdempotency(client:PoolClient,operation:string,key:string,response:unknown){
  await client.query(`UPDATE commercial_idempotency_records SET status='completed',response_json=$3::jsonb,completed_at=now()
    WHERE operation=$1 AND idempotency_key=$2 AND status='pending'`,[operation,key,JSON.stringify(response)]);
}
