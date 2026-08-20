import { decodeCommercialCursor } from "./commercial-api-support.ts";
import { readResearchJson } from "./research-api.ts";
import { ResearchApiError } from "./research-errors.ts";

export function commercialListInput(request: Request) {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isInteger(rawLimit) || rawLimit < 1) throw new ResearchApiError("VALIDATION_ERROR", "limit 无效", 422, { fields: ["limit"] });
  try { return { url, limit: Math.min(rawLimit, 100), cursor: decodeCommercialCursor(url.searchParams.get("cursor")) }; }
  catch { throw new ResearchApiError("VALIDATION_ERROR", "cursor 无效", 422, { fields: ["cursor"] }); }
}

export async function commercialJson(request: Request) { return readResearchJson(request, 16_384); }
export function requiredString(body: Record<string, unknown>, key: string, maximum = 500) {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (!value || value.length > maximum) throw new ResearchApiError("VALIDATION_ERROR", `${key} 无效`, 422, { fields: [key] });
  return value;
}
export function optionalString(body: Record<string, unknown>, key: string, maximum = 500) {
  if (body[key] === undefined || body[key] === null || body[key] === "") return undefined;
  return requiredString(body,key,maximum);
}
export function stringArray(body: Record<string, unknown>, key: string, maximum = 20) {
  const value=body[key];
  if(!Array.isArray(value)||value.length>maximum||value.some(item=>typeof item!=="string"||!item.trim()))
    throw new ResearchApiError("VALIDATION_ERROR",`${key} 无效`,422,{fields:[key]});
  return value.map(item=>(item as string).trim());
}
export function requestId(request: Request) { return request.headers.get("x-request-id")?.trim().slice(0,128) || crypto.randomUUID(); }

export function idempotencyKey(request:Request){
  const value=request.headers.get("Idempotency-Key")?.trim()??"";
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(value))throw new ResearchApiError("IDEMPOTENCY_KEY_REQUIRED","必须提供有效的 Idempotency-Key 请求头",422,{fields:["Idempotency-Key"]});
  return value;
}

export function paymentEvidenceInput(body:Record<string,unknown>,expectedCurrency:"USD"|"USDT"){
  const evidenceKind=requiredString(body,"evidenceKind",40);
  if(!["bank_transfer","manual_invoice","provider_reference"].includes(evidenceKind))throw new ResearchApiError("VALIDATION_ERROR","evidenceKind 无效",422,{fields:["evidenceKind"]});
  const amount=requiredString(body,"amount",50);
  if(!/^\d+(?:\.\d{1,18})?$/.test(amount)||Number(amount)<=0)throw new ResearchApiError("VALIDATION_ERROR","amount 必须是正数且最多 18 位小数",422,{fields:["amount"]});
  const currency=requiredString(body,"currency",10).toUpperCase();
  if(currency!==expectedCurrency)throw new ResearchApiError("VALIDATION_ERROR",`currency 必须为 ${expectedCurrency}`,422,{fields:["currency"]});
  const occurredAt=requiredString(body,"occurredAt",40);const occurred=new Date(occurredAt);
  if(Number.isNaN(occurred.valueOf())||occurred.getTime()>Date.now()+300_000)throw new ResearchApiError("VALIDATION_ERROR","occurredAt 无效或晚于当前时间",422,{fields:["occurredAt"]});
  const note=optionalString(body,"note",500);
  return {evidenceKind,providerLabel:optionalString(body,"providerLabel",80),reference:requiredString(body,"reference",256),amount,currency,occurredAt:occurred.toISOString(),note};
}
