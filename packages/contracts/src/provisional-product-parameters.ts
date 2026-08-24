/**
 * P-01–P-12 的**临时占位参数集**。
 *
 * 需求方 2026-08-24 决定：这些参数暂时用 mock 值推进开发，等功能完成后一次性补齐真值。
 * 当前环境不是真实生产，因此这个取舍是合理的——但它触碰了本项目最核心的一条纪律
 * （INV-6：未达门槛必须显式标注；PRD 第 15 节：不得用假设替代需求方结论）。所以占位值
 * 不是散落在各处的字面量，而是集中在这一个文件里，并带三重保护：
 *
 * 1. **单一真源。** 补真值时改这一个文件，不用满仓库找占位符。每项都带 `parameter`
 *    编号，可以逐条核对 PRD 第 15 节。
 * 2. **显式标注。** 每一项都带 `provisional: true`；消费方把它投影到 UI 或 API 时必须
 *    把这个标记一并带出，界面上显示「占位参数，未经需求方确认」，不能伪装成已确认配置。
 * 3. **生产失败关闭。** `assertProvisionalParametersAllowed()` 在
 *    `RIVERTON_ALLOW_PROVISIONAL_PARAMETERS !== "true"` 时直接抛错。生产环境不设这个
 *    变量，因此任何试图用占位价格下单、用占位门槛上架策略的调用都会失败，而不是静默
 *    按假值执行。
 *
 * **这些值没有任何一项经过需求方确认。** 它们的作用是让 schema、状态机、测试和 UI 能
 * 被完整构建与验证；数值本身随时会整体替换，不要在别处硬编码复制。
 */

export type ProvisionalParameter<T> = {
  /** PRD 第 15 节的参数编号，便于逐条核对与替换。 */
  parameter: `P-${string}`;
  /** 恒为 true。消费方必须把它传递到对外投影里。 */
  provisional: true;
  /** 一句话说明这个占位值是怎么来的，避免后来者把它当成调研结论。 */
  rationale: string;
  value: T;
};

function provisional<T>(parameter: `P-${string}`, rationale: string, value: T): ProvisionalParameter<T> {
  return { parameter, provisional: true, rationale, value };
}

/** P-01：五家首期交易所的开发优先顺序与 MetaMask 用途。 */
export const PROVISIONAL_EXCHANGE_PRIORITY = provisional(
  "P-01",
  "按仓库已有适配器成熟度排序：Binance/OKX 已有实盘适配器，其余三家仅有目录登记。MetaMask 保守取「只读钱包身份」，不赋予下单能力。",
  {
    // 顺序即开发与认证顺序；每家仍需独立 G4A，不因排在前面而自动解锁。
    order: ["binance", "okx", "coinbase", "crypto_com", "kraken"] as const,
    metamask: {
      purpose: "wallet_identity_readonly" as const,
      // 保守默认：钱包不参与下单与资金出站，避免占位期把签名能力引进执行链路。
      allowsOrderSigning: false,
      allowsFundsMovement: false,
    },
  },
);

/** P-02：外汇与贵金属的场所、产品、杠杆和服务地区。 */
export const PROVISIONAL_FX_METALS = provisional(
  "P-02",
  "无场所与牌照结论，因此占位为「只读行情、不可交易」——这与 PRD「先只读行情，不能由行情存在推导可交易」一致。",
  {
    venues: [] as readonly string[],
    tradable: false,
    maxLeverage: 1,
    serviceRegions: [] as readonly string[],
    readOnlyQuotes: true,
  },
);

/** P-03：A/HK/KR/JP 数据供应商、授权范围与 SLA。 */
export const PROVISIONAL_EQUITY_MARKET_DATA = provisional(
  "P-03",
  "无供应商合同，占位为延迟行情 + 保守 SLA，使 stale Gate 与降级路径可被测试；不声称任何实时授权。",
  {
    markets: {
      "equities-cn": { provider: "provisional-cn", realtime: false, delayMinutes: 15 },
      "equities-hk": { provider: "provisional-hk", realtime: false, delayMinutes: 15 },
      "equities-kr": { provider: "provisional-kr", realtime: false, delayMinutes: 20 },
      "equities-jp": { provider: "provisional-jp", realtime: false, delayMinutes: 20 },
    },
    slaLatencyMs: 500,
    slaReconnectSeconds: 10,
  },
);

/** P-04：QuantDinger 仓库、演示地址与可移植版本。 */
export const PROVISIONAL_QUANTDINGER = provisional(
  "P-04",
  "未取得仓库与演示地址。占位只固定「差异清单的形状」，不虚构 URL——空引用比假 URL 安全。",
  {
    repositoryUrl: null as string | null,
    demoUrl: null as string | null,
    portableVersion: null as string | null,
    /** 已在 PRD 6.3 明确的移植结论，与仓库地址无关，可以先实现。 */
    confirmedRemovals: ["watchlist", "analysis_symbol_picker", "legacy_eight_cards"] as const,
  },
);

/** P-05：策略回测门槛、模拟盘时长、收益/回撤标准。 */
export const PROVISIONAL_STRATEGY_ADMISSION = provisional(
  "P-05",
  "取三张官方卡里最严格的一档作为占位下限（回撤 6%），模拟盘时长取 30 天这一常见审核窗口。刻意偏保守：占位期宁可挡住合格策略，也不要放行不合格的。",
  {
    minimumBacktestDays: 180,
    minimumPaperTradingDays: 30,
    minimumTrades: 30,
    maximumDrawdownPct: 6,
    minimumNetReturnPct: 0,
    minimumProfitFactor: 1.2,
    requiresManualReview: true,
    requiresRiskDisclosure: true,
  },
);

/** P-06：跟单订阅费、收益分成、作者/平台分账、结算与退款。 */
export const PROVISIONAL_FOLLOW_FEES = provisional(
  "P-06",
  "沿用现有 Paper 绩效分成的 20% 费率与 UTC 周 + 高水位口径（INV-5），作者/平台按 5:5 占位。结算与退款沿用现有人工双审，不引入自动扣款。",
  {
    subscriptionFeeUsdt: "0",
    performanceFeeRate: "0.20",
    authorShareRate: "0.50",
    platformShareRate: "0.50",
    settlementCycle: "utc_week" as const,
    highWaterMark: true,
    refundPolicy: "manual_review_only" as const,
  },
);

/** P-07：四档套餐的 USDT 价格、Credits、权益与生效日。 */
export const PROVISIONAL_MEMBERSHIP_PLANS = provisional(
  "P-07",
  "直接沿用 packages/contracts 里已在跑的 v1 四档快照，不另造一套数字——占位值与当前生产基线一致，替换时差异最小。",
  {
    plans: [
      { code: "monthly_v1", priceUsdt: "28", durationDays: 30, credits: 1_000, performanceFeeRate: "0.20" },
      { code: "quarterly_v1", priceUsdt: "58", durationDays: 90, credits: 3_000, performanceFeeRate: "0.20" },
      { code: "annual_v1", priceUsdt: "198", durationDays: 365, credits: 12_000, performanceFeeRate: "0.20" },
      { code: "lifetime_v1", priceUsdt: "588", durationDays: null, credits: 36_000, performanceFeeRate: "0.16" },
    ],
    effectiveFrom: null as string | null,
  },
);

/** P-08：每次 AI 对话固定 Credits 值与模型/功能分档。 */
export const PROVISIONAL_AI_CREDIT_PRICING = provisional(
  "P-08",
  "当前实现按可信 provider usage 结算（token-cost-v1）。占位给出固定分档的形状与量级，使「固定扣费」这条产品目标可被实现与测试；数值本身未经财务确认。",
  {
    conversationCredits: 10,
    strategyGenerationCredits: 50,
    tiers: [
      { tier: "standard", multiplier: "1.0" },
      { tier: "advanced", multiplier: "3.0" },
    ],
  },
);

/** P-09：提现/划转网络、限额、白名单、服务费、审批与退款。 */
export const PROVISIONAL_FUNDS_OUTBOUND = provisional(
  "P-09",
  "资金出站是独立高风险产品。占位保持全部关闭：即使功能开发完成，没有真实结论前 endpoint 也必须固定拒绝（PRD 7.3、G5）。",
  {
    enabled: false,
    networks: [] as readonly string[],
    dailyLimitUsdt: "0",
    singleLimitUsdt: "0",
    requiresAddressAllowlist: true,
    coolingPeriodHours: 24,
    serviceFeeRate: "0",
    requiresMakerChecker: true,
  },
);

/** P-10：六套主题设计稿、品牌 token 与 Logo 资源。 */
export const PROVISIONAL_THEMES = provisional(
  "P-10",
  "无设计稿。占位从现有 --rv-* 令牌派生三浅三深的结构，使主题切换、对比度与四断点可被验收；具体色值等设计交付后整体替换。",
  {
    light: ["riverton-light", "neutral-light", "high-contrast-light"] as const,
    dark: ["riverton-dark", "neutral-dark", "high-contrast-dark"] as const,
    defaultLight: "riverton-light" as const,
    defaultDark: "riverton-dark" as const,
    brandAccent: "var(--rv-brand)",
  },
);

/** P-11：正式域名冻结日。 */
export const PROVISIONAL_DOMAINS = provisional(
  "P-11",
  "沿用当前已部署的三端域名，冻结日留空——域名变更会牵动 Cookie、CORS、回跳、邮件链接与 TLS，不能由占位值决定。",
  {
    client: "agentnovas.com",
    operations: "zht.agentnovas.com",
    maintenance: "xm.agentnovas.com",
    freezeDate: null as string | null,
  },
);

/** P-12：目标验收日期与业务节点。 */
export const PROVISIONAL_MILESTONES = provisional(
  "P-12",
  "无排期结论。占位只保留里程碑结构，日期一律为 null——填假日期会把未经估算的目标伪装成承诺（路线图第 13 节）。",
  {
    milestones: [
      { id: "M1", scope: "Phase 1–3", targetDate: null as string | null },
      { id: "M2", scope: "Phase 4", targetDate: null as string | null },
      { id: "M3", scope: "Phase 5 单 provider", targetDate: null as string | null },
      { id: "M4", scope: "Phase 6/7/8", targetDate: null as string | null },
      { id: "M5", scope: "Phase 9", targetDate: null as string | null },
    ],
  },
);

export const PROVISIONAL_PRODUCT_PARAMETERS = Object.freeze({
  "P-01": PROVISIONAL_EXCHANGE_PRIORITY,
  "P-02": PROVISIONAL_FX_METALS,
  "P-03": PROVISIONAL_EQUITY_MARKET_DATA,
  "P-04": PROVISIONAL_QUANTDINGER,
  "P-05": PROVISIONAL_STRATEGY_ADMISSION,
  "P-06": PROVISIONAL_FOLLOW_FEES,
  "P-07": PROVISIONAL_MEMBERSHIP_PLANS,
  "P-08": PROVISIONAL_AI_CREDIT_PRICING,
  "P-09": PROVISIONAL_FUNDS_OUTBOUND,
  "P-10": PROVISIONAL_THEMES,
  "P-11": PROVISIONAL_DOMAINS,
  "P-12": PROVISIONAL_MILESTONES,
});

export const PROVISIONAL_PARAMETER_ENV = "RIVERTON_ALLOW_PROVISIONAL_PARAMETERS";

export class ProvisionalParameterError extends Error {
  readonly code = "PROVISIONAL_PARAMETER_NOT_ALLOWED";
  constructor(parameter: string) {
    super(`${parameter} 仍是未经需求方确认的占位参数，当前环境不允许使用`);
    this.name = "ProvisionalParameterError";
  }
}

/**
 * 占位参数的生产闸门。
 *
 * 只有精确值 `"true"` 才放行——缺失、空值或其他值一律拒绝，与 `MFA_ENFORCEMENT_ENABLED`
 * 的判定方式保持一致。生产环境不设这个变量，因此任何试图用占位价格下单、用占位门槛
 * 上架策略的调用都会抛错而不是静默按假值执行。
 */
export function assertProvisionalParametersAllowed(
  parameter: keyof typeof PROVISIONAL_PRODUCT_PARAMETERS,
  environment: Record<string, string | undefined> = process.env,
) {
  if (environment[PROVISIONAL_PARAMETER_ENV] !== "true") {
    throw new ProvisionalParameterError(parameter);
  }
  return PROVISIONAL_PRODUCT_PARAMETERS[parameter];
}

/** 对外投影时必须带上的标记，避免占位值在 UI 或 API 里伪装成已确认配置（INV-6）。 */
export function provisionalDisclosure(parameter: keyof typeof PROVISIONAL_PRODUCT_PARAMETERS) {
  const entry = PROVISIONAL_PRODUCT_PARAMETERS[parameter];
  return {
    parameter: entry.parameter,
    provisional: true as const,
    confirmed: false as const,
    notice: "占位参数，未经需求方确认，不得作为对外承诺",
    rationale: entry.rationale,
  };
}
