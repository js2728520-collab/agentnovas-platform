import { createHash } from "node:crypto";

import {
  defaultMarketVisibility,
  registeredMarkets,
} from "../packages/contracts/src/market-provider-registry.ts";
import { ResearchApiError } from "./research-errors.ts";

/**
 * 市场可见性配置族（P-03）。
 *
 * 可见性不是功能开关：它决定客户能不能看到某个市场。改错会直接对外露出未授权或未就绪
 * 的行情，因此走版本化配置的完整流程，并且**判定方向是失败关闭**——只有注册表里存在、
 * 且配置显式写了 `true` 的市场才可见。
 *
 * 与 feature flag 的关键差别：功能开关没有 active 配置时沿用环境 Gate 的默认行为，
 * 而这里没有 active 配置时回落到注册表默认可见性。原因是市场清单本身来自已冻结的
 * P-03，不是一个可以「默认关掉」的运行时能力；全部隐藏会让行情页整个空掉。
 */

export const MARKET_VISIBILITY_FAMILY = Object.freeze({
  kind: "market",
  key: "client.market_visibility",
  audience: "shared",
  schemaVersion: 1,
});

const TESTER_ID = "market-visibility-v1";

function schemaError(message: string, fields?: string[]): never {
  throw new ResearchApiError(
    "CONFIGURATION_FAMILY_SCHEMA_INVALID",
    message,
    422,
    fields?.length ? { fields } : undefined,
  );
}

export function isMarketVisibilityFamily(input: {
  kind: string;
  key: string;
  audience: string;
  schemaVersion: number;
}) {
  return input.kind === MARKET_VISIBILITY_FAMILY.kind
    && input.key === MARKET_VISIBILITY_FAMILY.key
    && input.audience === MARKET_VISIBILITY_FAMILY.audience
    && input.schemaVersion === MARKET_VISIBILITY_FAMILY.schemaVersion;
}

/**
 * payload 形如 `{ "markets": { "equities-au": false } }`。
 *
 * 只允许注册表里已登记的 marketId。未知 ID 拒绝而不是忽略：静默忽略会让运维以为自己
 * 关掉了某个市场，实际上那条配置从未生效——一个拼错的 ID 造成的是「以为关了其实开着」。
 */
export function normalizeMarketVisibilityPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    schemaError("市场可见性 payload 必须是对象");
  }
  const value = payload as Record<string, unknown>;
  const extras = Object.keys(value).filter((key) => key !== "markets");
  if (extras.length) schemaError("市场可见性 payload 只允许 markets", extras);

  const markets = value.markets;
  if (!markets || typeof markets !== "object" || Array.isArray(markets)) {
    schemaError("markets 必须是对象");
  }

  const known = new Set(registeredMarkets().map((market) => market.id));
  const entries = Object.entries(markets as Record<string, unknown>);
  if (entries.length === 0) schemaError("markets 至少要包含一个市场");

  const unknown = entries.map(([id]) => id).filter((id) => !known.has(id));
  if (unknown.length) {
    schemaError("markets 包含未注册的市场 ID；拼错的 ID 会让配置看起来生效但实际未生效", unknown);
  }
  const nonBoolean = entries.filter(([, visible]) => typeof visible !== "boolean").map(([id]) => id);
  if (nonBoolean.length) schemaError("市场可见性只能是布尔值", nonBoolean);

  // 规范化为按 ID 排序的对象，让同一份意图无论键序如何都得到同一个摘要。
  const normalized: Record<string, boolean> = {};
  for (const [id, visible] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    normalized[id] = visible as boolean;
  }
  return { markets: normalized };
}

/**
 * 确定性测试器。除 schema 外还有一条产品断言：**加密市场不能被隐藏**。
 *
 * 加密是当前唯一进入执行路径的市场，三张官方策略卡都跑在上面。把它藏起来不会停掉
 * Runtime，只会让客户看不到自己组合正在交易的市场——界面与实际行为不一致，比看不到
 * 更糟。要停加密交易应该用紧急暂停，不是改可见性。
 */
export function runMarketVisibilityTest(input: {
  kind: string;
  key: string;
  audience: string;
  schemaVersion: number;
  payload: unknown;
}) {
  if (!isMarketVisibilityFamily(input)) {
    throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该市场可见性配置族尚未注册", 422);
  }
  const payload = normalizeMarketVisibilityPayload(input.payload);
  const executionMarkets = registeredMarkets()
    .filter((market) => market.usage.includes("execution"))
    .map((market) => market.id);

  const hiddenExecutionMarkets = executionMarkets.filter((id) => payload.markets[id] === false);
  const checks = [
    { id: "schema", passed: true },
    { id: "registered_markets_only", passed: true },
    { id: "execution_market_visible", passed: hiddenExecutionMarkets.length === 0 },
  ];

  const failed = checks.filter((check) => !check.passed).map((check) => check.id);
  const evidence = JSON.stringify({
    testerId: TESTER_ID,
    kind: input.kind,
    key: input.key,
    audience: input.audience,
    schemaVersion: input.schemaVersion,
    payload,
    checks,
    hiddenExecutionMarkets,
    result: failed.length ? "failed" : "passed",
  });

  return {
    result: failed.length ? ("failed" as const) : ("passed" as const),
    failedChecks: failed,
    evidenceSha256: createHash("sha256").update(evidence, "utf8").digest("hex"),
    testerId: TESTER_ID,
  };
}

/**
 * 运行时消费者：把 active 配置叠加到注册表默认可见性上。
 *
 * 配置只能**收窄**——它可以把一个默认可见的市场关掉，但不能让注册表里不存在的市场
 * 出现。这与 feature flag「active 只能进一步收窄环境 Gate」是同一条规则：配置不是
 * 新的能力来源，只是对既有能力的限制。
 */
export function resolveMarketVisibility(activePayload: unknown): Record<string, boolean> {
  const visibility = defaultMarketVisibility();
  if (activePayload === null || activePayload === undefined) return visibility;
  try {
    const { markets } = normalizeMarketVisibilityPayload(activePayload);
    for (const [id, visible] of Object.entries(markets)) {
      // 只接受注册表里已有的 ID，且只允许把 true 改成 false。
      if (id in visibility && visible === false) visibility[id] = false;
    }
    return visibility;
  } catch {
    // 非法配置失败关闭到默认可见性，而不是把所有市场隐藏——后者会让行情页整个空掉，
    // 是比「多显示一个市场」严重得多的故障。
    return defaultMarketVisibility();
  }
}
