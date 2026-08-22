import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { notificationDeliveries } from "@/db/schema";
import { readResearchJson, researchErrorResponse, ResearchApiError } from "@/lib/research-api";
import { requireUser } from "@/lib/session";

const publicPayloadKeys = new Set([
  "action", "amount", "currency", "membershipId", "noticeEndsAt", "orderId",
  "portfolioId", "reason", "statementId", "status", "strategyCode", "strategyId",
  "strategyName", "weekEnd", "weekStart",
]);

function safePayload(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, item]) => {
      if (!publicPayloadKeys.has(key)) return [];
      if (typeof item === "string") return [[key, item.slice(0, 300)]];
      if (typeof item === "number" || typeof item === "boolean" || item === null) return [[key, item]];
      return [];
    }));
  } catch {
    return {};
  }
}

async function notificationUser(request: Request) {
  return requireUser(request, ["customer"]);
}

export async function GET(request: Request) {
  try {
    const user = await notificationUser(request), db = getDb();
    const summary = new URL(request.url).searchParams.get("summary") === "1";
    if (summary) {
      const [row] = await db.select({ unread: count() }).from(notificationDeliveries).where(and(
        eq(notificationDeliveries.userId, user.id),
        eq(notificationDeliveries.channel, "in_app"),
        isNull(notificationDeliveries.readAt),
      ));
      return Response.json({ unread: Number(row?.unread ?? 0) }, { headers: { "cache-control": "no-store" } });
    }
    const rows = await db.select().from(notificationDeliveries).where(and(eq(notificationDeliveries.userId, user.id), eq(notificationDeliveries.channel, "in_app"))).orderBy(desc(notificationDeliveries.createdAt)).limit(100);
    return Response.json({ unread: rows.filter(row => !row.readAt).length, notifications: rows.map(row => ({ id: row.id, category: row.category, templateKey: row.templateKey, status: row.status, payload: safePayload(row.payloadJson), createdAt: row.createdAt, readAt: row.readAt })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}

export async function PATCH(request: Request) {
  try {
    const user = await notificationUser(request), body = await readResearchJson(request, 2_048), db = getDb(), now = new Date().toISOString();
    const notificationId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
    let affectedCount = 0;
    if (body.all === true) {
      const changed = await db.update(notificationDeliveries).set({ readAt: now, updatedAt: now }).where(and(eq(notificationDeliveries.userId, user.id), eq(notificationDeliveries.channel, "in_app"), isNull(notificationDeliveries.readAt))).returning({ id: notificationDeliveries.id });
      affectedCount = changed.length;
    }
    else if (notificationId) {
      const changed = await db.update(notificationDeliveries).set({ readAt: now, updatedAt: now }).where(and(eq(notificationDeliveries.id, notificationId), eq(notificationDeliveries.userId, user.id), eq(notificationDeliveries.channel, "in_app"))).returning({ id: notificationDeliveries.id });
      if (!changed.length) throw new ResearchApiError("NOTIFICATION_NOT_FOUND", "通知不存在或当前账户不可见", 404);
      affectedCount = changed.length;
    }
    else throw new ResearchApiError("VALIDATION_ERROR", "请选择要标记的通知", 422, { fields: ["id", "all"] });
    return Response.json({ ok: true, readAt: now, affectedCount }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
