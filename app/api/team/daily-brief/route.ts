import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionCases, customerAttributions, memberships, monthlyTeamTargets, notificationDeliveries, targetFollowUps, trades, users } from "@/db/schema";
import { canSeeCustomer } from "@/lib/permissions";
import { requireUser, responseError } from "@/lib/session";

const roles = ["branch_admin", "manager", "supervisor", "employee"] as const;
async function buildBrief(actor: typeof users.$inferSelect) {
  const db = getDb(), now = new Date(), today = now.toISOString().slice(0, 10), month = today.slice(0, 7), soon = new Date(now.getTime() + 7 * 86400_000).toISOString();
  const [attributions, collections, memberRows, tradeRows, targets, followUps, people] = await Promise.all([
    db.select().from(customerAttributions).where(eq(customerAttributions.status, "active")),
    db.select().from(collectionCases).where(inArray(collectionCases.status, ["payment_period", "grace", "trading_stopped"])),
    db.select().from(memberships), db.select().from(trades), db.select().from(monthlyTeamTargets).where(eq(monthlyTeamTargets.month, month)), db.select().from(targetFollowUps).where(and(eq(targetFollowUps.month, month), eq(targetFollowUps.status, "resolved"))),
    db.select({ id: users.id, organizationId: users.organizationId, reportsToUserId: users.reportsToUserId, createdAt: users.createdAt }).from(users),
  ]);
  const visibleAttributions = attributions.filter(row => canSeeCustomer(actor.role, actor.id, actor.organizationId, row)), customerIds = new Set(visibleAttributions.map(row => row.customerId)), peopleMap = new Map(people.map(row => [row.id, row]));
  const visibleStaff = people.filter(person => { if (person.organizationId !== actor.organizationId || person.id === actor.id) return false; if (actor.role === "branch_admin") return true; let current = person, depth = 0; while (current.reportsToUserId && depth++ < 6) { if (current.reportsToUserId === actor.id) return true; const next = peopleMap.get(current.reportsToUserId); if (!next) break; current = next; } return false; });
  const targetIds = new Set(targets.map(row => row.assigneeUserId)), handled = new Set(followUps.map(row => `${row.subjectUserId}:${row.alertType}`));
  const summary = { customers: customerIds.size, collections: collections.filter(row => customerIds.has(row.customerId)).length, stopped: collections.filter(row => customerIds.has(row.customerId) && row.status === "trading_stopped").length, expiring: memberRows.filter(row => customerIds.has(row.customerId) && !!row.expiresAt && row.expiresAt <= soon && row.expiresAt >= today).length, openTrades: tradeRows.filter(row => customerIds.has(row.customerId) && !row.closedAt).length, targetMissing: visibleStaff.filter(row => !targetIds.has(row.id) && !handled.has(`${row.id}:target_missing`)).length };
  return { date: today, month, scope: actor.role, summary };
}

export async function GET(request: Request) { try { const actor = await requireUser(request, [...roles]); return Response.json(await buildBrief(actor)); } catch (error) { return responseError(error); } }

export async function POST(request: Request) {
  try {
    const actor = await requireUser(request, [...roles]), brief = await buildBrief(actor), db = getDb(), now = new Date().toISOString(), channels = ["in_app", "email"] as const, created: string[] = [];
    for (const channel of channels) { const dedupeKey = `team-daily-brief:${actor.id}:${brief.date}:${channel}`; try { await db.insert(notificationDeliveries).values({ id: crypto.randomUUID(), userId: actor.id, channel, category: "team_daily_brief", templateKey: "team_daily_brief", dedupeKey, payloadJson: JSON.stringify(brief), scheduledAt: now }); created.push(channel); } catch (error) { if (!(error instanceof Error) || !/unique|UNIQUE/i.test(error.message)) throw error; } }
    return Response.json({ message: created.length ? `运营日报已加入${created.length}个通知渠道` : "今日日报已生成，无需重复发送", queuedChannels: created, brief });
  } catch (error) { return responseError(error); }
}

export async function PUT(request: Request) {
  try { const actor = await requireUser(request, [...roles]), since = new Date(Date.now() - 30 * 86400_000).toISOString(), rows = await getDb().select().from(notificationDeliveries).where(and(eq(notificationDeliveries.userId, actor.id), eq(notificationDeliveries.category, "team_daily_brief"), gte(notificationDeliveries.createdAt, since))).orderBy(desc(notificationDeliveries.createdAt)).limit(60); return Response.json({ deliveries: rows.map(row => ({ ...row, payload: JSON.parse(row.payloadJson) })) }); } catch (error) { return responseError(error); }
}
