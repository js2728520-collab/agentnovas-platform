import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { notificationChannels } from "@/db/schema";
import { randomToken, sha256 } from "@/lib/auth";
import { requireUser, responseError } from "@/lib/session";

export async function GET(request: Request) { try { const user = await requireUser(request); return Response.json({ channels: await getDb().select({ id: notificationChannels.id, channel: notificationChannels.channel, destination: notificationChannels.destination, status: notificationChannels.status, verifiedAt: notificationChannels.verifiedAt }).from(notificationChannels).where(eq(notificationChannels.userId, user.id)) }); } catch (error) { return responseError(error); } }

export async function POST(request: Request) {
  try {
    const user = await requireUser(request), body = await request.json() as { channel?: "telegram" | "whatsapp"; destination?: string };
    if (!body.channel || !body.destination?.trim()) return Response.json({ error: "请选择渠道并填写账号" }, { status: 400 });
    const token = randomToken(6), db = getDb();
    await db.insert(notificationChannels).values({ id: crypto.randomUUID(), userId: user.id, channel: body.channel, destination: body.destination.trim(), status: "pending", verificationTokenHash: await sha256(token) }).onConflictDoUpdate({ target: [notificationChannels.userId, notificationChannels.channel], set: { destination: body.destination.trim(), status: "pending", verificationTokenHash: await sha256(token), verifiedAt: null, updatedAt: new Date().toISOString() } });
    return Response.json({ ok: true, status: "pending", verificationCode: token, message: "验证码已生成；正式服务接入后将发送到对应渠道" });
  } catch (error) { return responseError(error); }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request), body = await request.json() as { channel?: "telegram" | "whatsapp"; verificationCode?: string };
    if (!body.channel || !body.verificationCode?.trim()) return Response.json({ error: "请输入验证码" }, { status: 400 });
    const db = getDb(), channel = (await db.select().from(notificationChannels).where(and(eq(notificationChannels.userId, user.id), eq(notificationChannels.channel, body.channel))).limit(1))[0];
    if (!channel || channel.status !== "pending" || channel.verificationTokenHash !== await sha256(body.verificationCode.trim())) return Response.json({ error: "验证码无效或渠道不存在" }, { status: 400 });
    const now = new Date().toISOString(); await db.update(notificationChannels).set({ status: "verified", verifiedAt: now, verificationTokenHash: null, updatedAt: now }).where(eq(notificationChannels.id, channel.id));
    return Response.json({ ok: true, status: "verified", message: "通知渠道已验证" });
  } catch (error) { return responseError(error); }
}
