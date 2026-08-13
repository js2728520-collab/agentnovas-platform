import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { notificationDeliveries } from "@/db/schema";
import { requireUser, responseError } from "@/lib/session";

function safePayload(value: string) { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }

export async function GET(request: Request) {
  try {
    const user = await requireUser(request), db = getDb();
    const rows = await db.select().from(notificationDeliveries).where(and(eq(notificationDeliveries.userId, user.id), eq(notificationDeliveries.channel, "in_app"))).orderBy(desc(notificationDeliveries.createdAt)).limit(100);
    return Response.json({ unread: rows.filter(row => !row.readAt).length, notifications: rows.map(row => ({ id: row.id, category: row.category, templateKey: row.templateKey, status: row.status, payload: safePayload(row.payloadJson), createdAt: row.createdAt, readAt: row.readAt })) });
  } catch (error) { return responseError(error); }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request), body = await request.json() as { id?: string; all?: boolean }, db = getDb(), now = new Date().toISOString();
    if (body.all) await db.update(notificationDeliveries).set({ readAt: now, updatedAt: now }).where(and(eq(notificationDeliveries.userId, user.id), eq(notificationDeliveries.channel, "in_app"), isNull(notificationDeliveries.readAt)));
    else if (body.id) await db.update(notificationDeliveries).set({ readAt: now, updatedAt: now }).where(and(eq(notificationDeliveries.id, body.id), eq(notificationDeliveries.userId, user.id), eq(notificationDeliveries.channel, "in_app")));
    else return Response.json({ error: "请选择要标记的通知" }, { status: 400 });
    return Response.json({ ok: true, readAt: now });
  } catch (error) { return responseError(error); }
}
