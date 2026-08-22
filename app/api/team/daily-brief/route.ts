import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionCases, customerAttributions, memberships, monthlyTeamTargets, notificationDeliveries, targetFollowUps, users } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { canAccessCustomerAttribution } from "@/lib/operations-access";
import type { DataScope } from "@/lib/rbac";
import { getPostgresPool } from "@/lib/postgres";
import { responseError } from "@/lib/session";

async function buildBrief(actor: typeof users.$inferSelect, scope: DataScope, organizationIds: readonly string[]) {
  const db = getDb(), now = new Date(), today = now.toISOString().slice(0, 10), month = today.slice(0, 7), soon = new Date(now.getTime() + 7 * 86400_000).toISOString();
  const [attributions, collections, memberRows, tradeRows, targets, followUps, people] = await Promise.all([
    db.select().from(customerAttributions).where(eq(customerAttributions.status, "active")),
    db.select().from(collectionCases).where(inArray(collectionCases.status, ["payment_period", "grace", "trading_stopped"])),
    db.select().from(memberships), (await getPostgresPool()).query<{ customer_id: string }>(`SELECT DISTINCT portfolio.customer_id FROM official_paper_positions position JOIN official_paper_portfolios portfolio ON portfolio.id=position.portfolio_id WHERE position.quantity>0`), db.select().from(monthlyTeamTargets).where(eq(monthlyTeamTargets.month, month)), db.select().from(targetFollowUps).where(and(eq(targetFollowUps.month, month), eq(targetFollowUps.status, "resolved"))),
    db.select({ id: users.id, organizationId: users.organizationId, reportsToUserId: users.reportsToUserId, createdAt: users.createdAt }).from(users),
  ]);
  const visibleAttributions = attributions.filter(row => canAccessCustomerAttribution(scope, { userId: actor.id, organizationId: actor.organizationId }, row, organizationIds)), customerIds = new Set(visibleAttributions.map(row => row.customerId)), peopleMap = new Map(people.map(row => [row.id, row]));
  const visibleStaff = people.filter(person => { if (person.organizationId !== actor.organizationId || person.id === actor.id) return false; if (actor.role === "branch_admin") return true; let current = person, depth = 0; while (current.reportsToUserId && depth++ < 6) { if (current.reportsToUserId === actor.id) return true; const next = peopleMap.get(current.reportsToUserId); if (!next) break; current = next; } return false; });
  const targetIds = new Set(targets.map(row => row.assigneeUserId)), handled = new Set(followUps.map(row => `${row.subjectUserId}:${row.alertType}`));
  const summary = { customers: customerIds.size, collections: collections.filter(row => customerIds.has(row.customerId)).length, stopped: collections.filter(row => customerIds.has(row.customerId) && row.status === "trading_stopped").length, expiring: memberRows.filter(row => customerIds.has(row.customerId) && !!row.expiresAt && row.expiresAt <= soon && row.expiresAt >= today).length, openTrades: tradeRows.rows.filter(row => customerIds.has(row.customer_id)).length, targetMissing: visibleStaff.filter(row => !targetIds.has(row.id) && !handled.has(`${row.id}:target_missing`)).length };
  return { date: today, month, scope: actor.role, summary };
}

export async function GET(request: Request) { try { const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.team.view"); return Response.json(await buildBrief(actor, scope, organizationIds)); } catch (error) { return responseError(error); } }

export async function POST(request: Request) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.team.manage"), brief = await buildBrief(actor, scope, organizationIds), db = getDb(), now = new Date().toISOString(), channels = ["in_app", "email"] as const, created: string[] = [];
    for (const channel of channels) { const dedupeKey = `team-daily-brief:${actor.id}:${brief.date}:${channel}`; try { await db.insert(notificationDeliveries).values({ id: crypto.randomUUID(), userId: actor.id, channel, category: "team_daily_brief", templateKey: "team_daily_brief", dedupeKey, payloadJson: JSON.stringify(brief), scheduledAt: now }); created.push(channel); } catch (error) { if (!(error instanceof Error) || !/unique|UNIQUE/i.test(error.message)) throw error; } }
    return Response.json({ message: created.length ? `运营日报已加入${created.length}个通知渠道` : "今日日报已生成，无需重复发送", queuedChannels: created, brief });
  } catch (error) { return responseError(error); }
}

export async function PUT(request: Request) {
  try { const { user: actor } = await requireAccessPermission(request, "ops.team.view"), since = new Date(Date.now() - 30 * 86400_000).toISOString(), rows = await getDb().select().from(notificationDeliveries).where(and(eq(notificationDeliveries.userId, actor.id), eq(notificationDeliveries.category, "team_daily_brief"), gte(notificationDeliveries.createdAt, since))).orderBy(desc(notificationDeliveries.createdAt)).limit(60); return Response.json({ deliveries: rows.map(row => ({ ...row, payload: JSON.parse(row.payloadJson) })) }); } catch (error) { return responseError(error); }
}
