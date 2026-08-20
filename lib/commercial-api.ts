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
