import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { marketWatchlist } from "@/db/schema";
import { marketInstruments, type MarketCategory } from "@/app/api/market/instruments/route";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";

const WATCHLIST_LIMIT = 20;

function resolveInstrument(symbol: unknown, category: unknown) {
  const normalizedSymbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return marketInstruments.find((item) => item.symbol === normalizedSymbol && item.category === category);
}

function responseItem(row: typeof marketWatchlist.$inferSelect) {
  const instrument = marketInstruments.find((item) => item.symbol === row.symbol && item.category === row.category);
  return instrument ? { ...instrument, id: row.id, createdAt: row.createdAt } : { id: row.id, symbol: row.symbol, label: row.symbol, name: row.symbol, nameZh: "", category: row.category as MarketCategory, providerSymbol: row.symbol, aliases: [], createdAt: row.createdAt };
}

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(request);
    const rows = await getDb().select().from(marketWatchlist).where(eq(marketWatchlist.customerId, user.id)).orderBy(desc(marketWatchlist.createdAt)).limit(WATCHLIST_LIMIT);
    return Response.json({ items: rows.map(responseItem), limit: WATCHLIST_LIMIT }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return responseError(error); }
}

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(request);
    const body = await request.json() as { symbol?: string; category?: MarketCategory };
    const instrument = resolveInstrument(body.symbol, body.category);
    if (!instrument) return Response.json({ error: "交易品种不存在或暂不支持关注" }, { status: 400 });
    const db = getDb();
    const existing = (await db.select().from(marketWatchlist).where(and(eq(marketWatchlist.customerId, user.id), eq(marketWatchlist.symbol, instrument.symbol))).limit(1))[0];
    if (existing) return Response.json({ item: responseItem(existing), message: "该产品已在关注列表中" });
    const count = (await db.select({ id: marketWatchlist.id }).from(marketWatchlist).where(eq(marketWatchlist.customerId, user.id)).limit(WATCHLIST_LIMIT + 1)).length;
    if (count >= WATCHLIST_LIMIT) return Response.json({ error: `最多关注 ${WATCHLIST_LIMIT} 个产品` }, { status: 409 });
    const row = { id: crypto.randomUUID(), customerId: user.id, symbol: instrument.symbol, category: instrument.category };
    await db.insert(marketWatchlist).values(row);
    return Response.json({ item: responseItem({ ...row, createdAt: new Date().toISOString() }), message: "已加入关注" }, { status: 201 });
  } catch (error) { return responseError(error); }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(request);
    const body = await request.json() as { symbol?: string };
    const symbol = String(body.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol) return Response.json({ error: "缺少需要取消关注的交易品种" }, { status: 400 });
    await getDb().delete(marketWatchlist).where(and(eq(marketWatchlist.customerId, user.id), eq(marketWatchlist.symbol, symbol)));
    return Response.json({ ok: true, symbol, message: "已取消关注" });
  } catch (error) { return responseError(error); }
}
