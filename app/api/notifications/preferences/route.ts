import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { notificationPreferences } from "@/db/schema";
import { normalizeNotificationPreferenceBatch } from "@/lib/notification-preferences";
import { readResearchJson, researchErrorResponse } from "@/lib/research-api";
import { requireUser } from "@/lib/session";


async function notificationUser(request: Request) {
  return requireUser(request, ["customer"]);
}

export async function GET(request: Request) {
  try {
    const user = await notificationUser(request);
    const preferences = await getDb().select({
      category: notificationPreferences.category,
      channel: notificationPreferences.channel,
      mode: notificationPreferences.mode,
      quietStart: notificationPreferences.quietStart,
      quietEnd: notificationPreferences.quietEnd,
    }).from(notificationPreferences)
      .where(eq(notificationPreferences.userId, user.id));
    return Response.json({ preferences }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await notificationUser(request);
    const body = await readResearchJson(request, 4_096);
    const entries = normalizeNotificationPreferenceBatch(body);
    const db = getDb();
    const updatedAt = new Date().toISOString();
    await db.batch(entries.map((entry) => db.insert(notificationPreferences).values({
      id: crypto.randomUUID(), userId: user.id, ...entry,
    }).onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.channel, notificationPreferences.category],
      set: { mode: entry.mode, quietStart: entry.quietStart, quietEnd: entry.quietEnd, updatedAt },
    })));
    return Response.json({ ok: true, updated: entries.length }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
