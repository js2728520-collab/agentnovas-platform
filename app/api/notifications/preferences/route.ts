import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { notificationPreferences } from "@/db/schema";
import { canDisableNotification } from "@/lib/business-rules";
import { readResearchJson, researchErrorResponse, ResearchApiError } from "@/lib/research-api";
import { requireUser } from "@/lib/session";

const allowedChannels = new Set(["in_app", "email"]);
const allowedCategories = new Set([
  "membership_billing",
  "api_security",
  "risk_circuit_breaker",
  "trade_execution",
  "market_news",
]);
const allowedModes = new Set(["instant", "digest", "important_only", "disabled"]);
const quietTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
type AllowedChannel = "in_app" | "email";
type AllowedMode = "instant" | "digest" | "important_only" | "disabled";

function optionalQuietTime(body: Record<string, unknown>, key: "quietStart" | "quietEnd") {
  const value = body[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !quietTimePattern.test(value)) {
    throw new ResearchApiError("VALIDATION_ERROR", `${key} 必须是 HH:mm`, 422, { fields: [key] });
  }
  return value;
}

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
    const channel = typeof body.channel === "string" ? body.channel : "";
    const category = typeof body.category === "string" ? body.category : "";
    const mode = typeof body.mode === "string" ? body.mode : "";
    if (!allowedChannels.has(channel) || !allowedCategories.has(category) || !allowedModes.has(mode)) {
      throw new ResearchApiError("VALIDATION_ERROR", "通知渠道、类别或模式无效", 422, {
        fields: ["channel", "category", "mode"],
      });
    }
    if (mode === "disabled" && !canDisableNotification(category)) {
      throw new ResearchApiError("MANDATORY_NOTIFICATION", "该安全或缴费通知不能关闭", 422);
    }
    const quietStart = optionalQuietTime(body, "quietStart");
    const quietEnd = optionalQuietTime(body, "quietEnd");
    const validatedChannel = channel as AllowedChannel;
    const validatedMode = mode as AllowedMode;
    const db = getDb();
    await db.insert(notificationPreferences).values({
      id: crypto.randomUUID(),
      userId: user.id,
      channel: validatedChannel,
      category,
      mode: validatedMode,
      quietStart,
      quietEnd,
    }).onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.channel, notificationPreferences.category],
      set: {
        mode: validatedMode,
        quietStart,
        quietEnd,
        updatedAt: new Date().toISOString(),
      },
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
