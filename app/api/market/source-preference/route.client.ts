import {
  isMarketVisible,
  OFFICIAL_CARD_PROVIDER_ID,
  OFFICIAL_CARD_STRATEGY_CODES,
  registeredMarkets,
} from "@/packages/contracts/src/market-provider-registry";
import { normalizeMarketSourceSelection } from "@/packages/contracts/src/market-source-binding";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import {
  assertSelectableMarketSource,
  listMarketSourcePreferences,
  saveMarketSourcePreference,
  selectableProvidersForMarket,
} from "@/lib/market-source-preference-repository";
import { platformDefaultSelection } from "@/lib/market-source-resolution";
import { loadActiveMarketVisibility } from "@/lib/market-visibility-repository";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { requireCurrentSession, responseError } from "@/lib/session";

/**
 * 客户的行情源偏好只作用于**行情展示与策略研发**。
 *
 * 官方策略卡恒用平台指定源（ADR-0025），响应里显式带上这一事实，界面才能说清楚——
 * 让客户以为改了偏好就换掉了官方卡的数据来源，是这个接口最容易造成的误解。
 */
const OFFICIAL_CARD_NOTICE = {
  strategyCodes: [...OFFICIAL_CARD_STRATEGY_CODES],
  providerId: OFFICIAL_CARD_PROVIDER_ID,
  followsPreference: false,
  reason: "官方策略卡的所有订阅者共享同一份七阶段判断，数据源由平台统一指定",
} as const;

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const current = await requireCurrentSession(request);
    const pool = await getPostgresPool();
    const visibility = await loadActiveMarketVisibility(pool);
    const preferences = await listMarketSourcePreferences(pool, current.user.id);
    const chosen = new Map(preferences.map((preference) => [preference.marketId, preference]));

    const markets = registeredMarkets()
      .filter((market) => isMarketVisible(market.id, visibility))
      .map((market) => {
        const preference = chosen.get(market.id) ?? null;
        const fallback = platformDefaultSelection(market.id);
        return {
          marketId: market.id,
          assetClass: market.assetClass,
          selectableProviderIds: selectableProvidersForMarket(market.id),
          // 「客户选了」与「还没选、正在用默认」必须分开，否则默认值看起来像一次选择。
          selection: preference?.selection ?? fallback,
          origin: preference ? "customer_preference" : "platform_default",
          updatedAt: preference?.updatedAt ?? null,
        };
      });

    return Response.json(
      { markets, appliesTo: ["display", "research"], officialCards: OFFICIAL_CARD_NOTICE },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) { return responseError(error, request.headers.get("x-request-id") ?? undefined); }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const current = await requireCurrentSession(request);
    const input = await readResearchJson(request, 2_048);
    const marketId = String(input.marketId ?? "");
    let selection;
    try {
      selection = normalizeMarketSourceSelection(input.selection);
    } catch {
      // 合同的报错信息面向开发者，直接回传会把内部字段名暴露给浏览器。
      throw new ResearchApiError("MARKET_SOURCE_SELECTION_INVALID", "行情源选择格式不正确", 422);
    }

    const pool = await getPostgresPool();
    await assertSelectableMarketSource(pool, {
      ownerUserId: current.user.id,
      marketId,
      selection,
      visibility: await loadActiveMarketVisibility(pool),
    });
    const saved = await saveMarketSourcePreference(pool, {
      ownerUserId: current.user.id,
      marketId,
      selection,
    });

    return Response.json(
      { ok: true, preference: saved, appliesTo: ["display", "research"], officialCards: OFFICIAL_CARD_NOTICE },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) { return responseError(error, request.headers.get("x-request-id") ?? undefined); }
}
