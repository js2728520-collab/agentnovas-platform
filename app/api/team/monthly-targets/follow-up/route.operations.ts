import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, targetFollowUps, users } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";

function visibleTo(actor: { id: string; role: string; organizationId: string | null }, target: { id: string; organizationId: string | null; reportsToUserId: string | null } | undefined, people: Map<string, { id: string; organizationId: string | null; reportsToUserId: string | null }>) {
  if (!target || target.organizationId !== actor.organizationId) return false;
  if (actor.role === "branch_admin") return true;
  let current = target, depth = 0;
  while (current.reportsToUserId && depth++ < 6) { if (current.reportsToUserId === actor.id) return true; const next = people.get(current.reportsToUserId); if (!next) break; current = next; }
  return false;
}

export async function GET(request: Request) {
  try {
    const { user: actor } = await requireAccessPermission(request, "ops.team.view"), url = new URL(request.url), month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7), db = getDb();
    const people = await db.select({ id: users.id, email: users.email, organizationId: users.organizationId, reportsToUserId: users.reportsToUserId }).from(users), map = new Map(people.map(x => [x.id, x]));
    const rows = await db.select().from(targetFollowUps).where(eq(targetFollowUps.month, month));
    return Response.json({ month, followUps: rows.filter(row => visibleTo(actor, map.get(row.subjectUserId), map)).map(row => ({ ...row, subjectEmail: map.get(row.subjectUserId)?.email.replace(/^(.{2}).*(@.*)$/, "$1***$2"), handledByEmail: map.get(row.handledByUserId)?.email.replace(/^(.{2}).*(@.*)$/, "$1***$2") })) });
  } catch (error) { return responseError(error); }
}
export async function POST(request: Request) {
  try {
    const { user: actor } = await requireAccessPermission(request, "ops.team.manage"), body = await request.json() as { month?: string; subjectUserId?: string; alertType?: "target_missing" | "behind_schedule"; note?: string };
    if (!/^\d{4}-\d{2}$/.test(body.month || "") || !body.subjectUserId || !["target_missing", "behind_schedule"].includes(body.alertType || "")) return Response.json({ error: "缺少有效的跟进事项" }, { status: 400 });
    if (!body.note?.trim()) return Response.json({ error: "请填写跟进备注" }, { status: 400 });
    const db = getDb(), people = await db.select({ id: users.id, organizationId: users.organizationId, reportsToUserId: users.reportsToUserId }).from(users), map = new Map(people.map(x => [x.id, x])), target = map.get(body.subjectUserId), now = new Date().toISOString();
    const allowed = visibleTo(actor, target, map);
    if (!target || target.organizationId !== actor.organizationId || !allowed) return Response.json({ error: "只能处理自己下属范围的事项" }, { status: 403 });
    const existing = (await db.select().from(targetFollowUps).where(and(eq(targetFollowUps.subjectUserId, target.id), eq(targetFollowUps.month, body.month!), eq(targetFollowUps.alertType, body.alertType!))).limit(1))[0], id = existing?.id || crypto.randomUUID();
    await db.batch([
      db.insert(targetFollowUps).values({ id, month: body.month!, branchId: actor.organizationId!, subjectUserId: target.id, alertType: body.alertType!, status: "resolved", note: body.note.trim(), handledByUserId: actor.id, handledAt: now, updatedAt: now }).onConflictDoUpdate({ target: [targetFollowUps.subjectUserId, targetFollowUps.month, targetFollowUps.alertType], set: { status: "resolved", note: body.note.trim(), handledByUserId: actor.id, handledAt: now, updatedAt: now } }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: actor.id, action: "monthly_target.follow_up_resolved", subjectType: "user", subjectId: target.id, beforeJson: existing ? JSON.stringify(existing) : null, afterJson: JSON.stringify({ month: body.month, alertType: body.alertType, note: body.note.trim() }), ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") }),
    ]);
    return Response.json({ message: "跟进事项已标记为处理完成" });
  } catch (error) { return responseError(error); }
}

export async function PATCH(request: Request) {
  try {
    const { user: actor } = await requireAccessPermission(request, "ops.team.manage"), body = await request.json() as { id?: string; note?: string }, db = getDb();
    if (!body.id || !body.note?.trim()) return Response.json({ error: "请填写重新打开的原因" }, { status: 400 });
    const row = (await db.select().from(targetFollowUps).where(eq(targetFollowUps.id, body.id)).limit(1))[0];
    if (!row) return Response.json({ error: "跟进记录不存在" }, { status: 404 });
    const people = await db.select({ id: users.id, organizationId: users.organizationId, reportsToUserId: users.reportsToUserId }).from(users), map = new Map(people.map(x => [x.id, x]));
    if (!visibleTo(actor, map.get(row.subjectUserId), map)) return Response.json({ error: "只能操作自己下属范围的记录" }, { status: 403 });
    const now = new Date().toISOString(), note = `${row.note}\n[重新打开] ${body.note.trim()}`;
    await db.batch([db.update(targetFollowUps).set({ status: "reopened", note, handledByUserId: actor.id, handledAt: now, updatedAt: now }).where(eq(targetFollowUps.id, row.id)), db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: actor.id, action: "monthly_target.follow_up_reopened", subjectType: "target_follow_up", subjectId: row.id, beforeJson: JSON.stringify(row), afterJson: JSON.stringify({ status: "reopened", note }), ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") })]);
    return Response.json({ message: "事项已重新打开" });
  } catch (error) { return responseError(error); }
}
