/**
 * P-01–P-12 与 A-01–A-03 的**已确认产品参数**。
 *
 * 需求方于 2026-08-24 通过《AgentNovas V3 产品参数确认单》逐项答复，五处歧义于同日
 * 澄清完毕。此前的 `provisional-product-parameters.ts` 占位机制已由本文件取代——
 * 所有参数现在都是需求方结论，不再需要「生产失败关闭」的占位闸门。
 *
 * 这仍是**单一真源**：改价格、改门槛、改限额都只改这一个文件。前端和领域层一律从这里
 * 读，不得复制第二份常量（CLAUDE.md「领域参数唯一真源」）。
 *
 * 「参数已冻结」不等于「Gate 已通过」。这些数字让实现可以开始，但每个高风险能力仍要
 * 走自己的 Gate；尤其 P-09 资金出站改变了 ADR-0015 的 deposit-only 硬边界，见 ADR-0024。
 */

export const PRODUCT_PARAMETERS_CONFIRMED_AT = "2026-08-24";
export const PRODUCT_PARAMETERS_SOURCE = "《AgentNovas V3 产品参数确认单》需求方答复及同日五项澄清";

/** P-01：交易所开发顺序。确认单在推荐五家之外追加了三家，共八家。 */
export const EXCHANGE_ROLLOUT_ORDER = Object.freeze([
  "binance", "okx", "coinbase", "crypto_com", "kraken", "gate_io", "bitget", "htx",
] as const);

export type ExchangeCode = (typeof EXCHANGE_ROLLOUT_ORDER)[number];

/**
 * P-01：MetaMask 首期不接入。
 *
 * 保留这个常量而不是直接删掉相关代码，是为了让「没接入」成为一个可被断言的事实——
 * 删掉之后，将来有人加回来时不会有任何检查提醒他这是个产品决定。
 */
export const METAMASK_INTEGRATION = Object.freeze({
  enabled: false,
  allowsOrderSigning: false,
  allowsFundsMovement: false,
});

/** P-02：外汇与贵金属只做行情展示，不开放交易。 */
export const FX_METALS_SCOPE = Object.freeze({
  quotesEnabled: true,
  tradable: false,
  venues: Object.freeze([] as readonly string[]),
});

/**
 * P-03：股票行情。首期六个市场、延迟 15 分钟；实时授权采购到位后由运维端改配置升级，
 * 不需要改代码。市场的隐藏/可见也在运维端控制。
 */
export const EQUITY_MARKETS = Object.freeze([
  "equities-us", "equities-cn", "equities-hk", "equities-kr", "equities-jp", "equities-au",
] as const);

export type EquityMarketCode = (typeof EQUITY_MARKETS)[number];

export const EQUITY_MARKET_DATA = Object.freeze({
  /** 首期统一延迟；升级为实时是运维端配置变更，不是代码变更。 */
  defaultMode: "delayed" as const,
  delayMinutes: 15,
  operatorConfigurableMode: true,
  operatorConfigurableVisibility: true,
  /** 供应商由技术团队选型后报需求方确认；这里不写死，避免把选型结论伪装成已确认。 */
  provider: null as string | null,
  slaLatencyMs: 500,
  slaReconnectSeconds: 10,
});

/** P-04：不做 QuantDinger 移植参考，AI 助手按现有方向演进。 */
export const QUANTDINGER_PORT = Object.freeze({
  enabled: false,
  /** PRD 6.3 已明确的改动与仓库参考无关，早已完成。 */
  completedRemovals: Object.freeze(["watchlist", "analysis_symbol_picker", "legacy_eight_cards"] as const),
});

export type StrategyRiskTier = "conservative" | "balanced" | "aggressive";

/**
 * P-05：客户策略上架门槛。
 *
 * 两处与官方策略卡的差异是需求方明确要的，不是笔误：
 *
 * 1. **不设模拟盘**，改为上架前人工审核。原推荐是 30 天模拟盘。
 * 2. **回撤上限按风险等级分三档（10/15/20%），高于官方三张卡的 6/10/15%。** 也就是说
 *    客户投稿的策略允许比平台自营策略更激进。这一点已向需求方指出并获确认。
 *
 * 三档阈值运营端可调，因此这里是默认值而不是硬上限；运营端的调整仍受 maker/checker 约束。
 */
export const STRATEGY_ADMISSION = Object.freeze({
  minimumBacktestDays: 180,
  /** 不设模拟盘时长要求；把关改由人工审核承担。 */
  requiresPaperTradingPeriod: false,
  minimumPaperTradingDays: 0,
  requiresManualReview: true,
  minimumTrades: 30,
  /** 收益为正即可；回撤与成交笔数一起构成筛选。 */
  minimumNetReturnPct: 0,
  maximumDrawdownPctByTier: Object.freeze({
    conservative: 10,
    balanced: 15,
    aggressive: 20,
  } as Record<StrategyRiskTier, number>),
  operatorConfigurableThresholds: true,
});

/**
 * P-06：跟单收费与作者分账。
 *
 * 结算口径**保持高水位线**。确认单正文一度写成「每周清零」，需求方澄清为笔误——两者
 * 是完全不同的算法（清零会对上周亏损后的反弹重复收费），高水位线也是 INV-5 的要求。
 */
export const FOLLOW_FEES = Object.freeze({
  subscriptionFeeUsdt: "0",
  performanceFeeRate: "0.20",
  authorShareRate: "0.50",
  platformShareRate: "0.50",
  settlementCycle: "utc_week" as const,
  highWaterMark: true,
  /** 已结算的分成不退；结算前的计算错误通过重算修正，走既有 revision 机制。 */
  settledFeesRefundable: false,
  /**
   * **模拟盘不收费**（需求方 2026-08-24 确认）。
   *
   * 分成只对实盘跟单产生的收益收取。模拟盘没有真实收益，对它收分成等于对一笔从未发生的
   * 盈利收钱。`shadow` 同理。
   *
   * 注意这与三张官方策略卡不同——官方卡的模拟组合确实产生真实绩效费，那是既有的商业模型
   * （见 `performance_fee_statements`）。两者是不同的产品，不要互相套用。
   */
  chargeableRunModes: ["live"] as const,
  /**
   * 作者分账的归属与记账时点（需求方 2026-08-24 确认）。
   *
   * 作者可以是平台用户，也可以是平台公司自己——都汇总到同一个账户体系，靠分类记账区分，
   * 不另起一套作者账户模型。分录在**结算单批准时**产生，不等收款确认。
   */
  authorPayout: Object.freeze({
    account: "platform_balance" as const,
    postAt: "settlement_approved" as const,
    /** 策略归谁，跟单产生的收益分成就归谁。 */
    followsStrategyOwnership: true,
  }),
});

/** P-07：四档套餐。价格与分成费率均由运营端调整，权限为分公司总经理及以上。 */
export const MEMBERSHIP_PLANS = Object.freeze([
  { code: "monthly_v1", priceUsdt: "59", durationDays: 30, credits: 1_000, performanceFeeRate: "0.20" },
  { code: "quarterly_v1", priceUsdt: "129", durationDays: 90, credits: 3_000, performanceFeeRate: "0.19" },
  { code: "annual_v1", priceUsdt: "499", durationDays: 365, credits: 12_000, performanceFeeRate: "0.18" },
  { code: "lifetime_v1", priceUsdt: "1999", durationDays: null, credits: 36_000, performanceFeeRate: "0.16" },
] as const);

export const MEMBERSHIP_PRICING_CONTROL = Object.freeze({
  operatorConfigurable: true,
  /** 改价是资金相关变更，仍走 maker/checker 与版本化发布，历史订单引用原快照（INV-5）。 */
  requiresMakerChecker: true,
  minimumRole: "branch_general_manager" as const,
  effectiveFrom: "first_release" as const,
});

/**
 * P-08：AI 积分扣费。
 *
 * 两种计费方式**同时保留**，默认固定扣费，运维端可切换。这不是折中：固定扣费让客户能
 * 预知花费，用量结算在定价未最终确定前保留精确计量能力，两者各自成立。
 */
export const AI_CREDIT_PRICING = Object.freeze({
  defaultMode: "fixed" as const,
  availableModes: Object.freeze(["fixed", "provider_usage"] as const),
  maintenanceConfigurable: true,
  conversationCredits: 1,
  strategyGenerationCredits: 10,
  modelTiers: Object.freeze([
    { tier: "standard", multiplier: "1.0" },
    { tier: "advanced", multiplier: "2.0" },
  ] as const),
});

/**
 * P-09：资金出站。
 *
 * **范围限定为平台服务余额提现**——客户充进平台的 USDT 余额可以提回去。这与 INV-11
 * 无关：INV-11 管的是「平台不持有客户**交易所账户**的提现权限」，交易凭证仍然只有
 * 读 + 交易权限，迁移 0045 的数据库约束保持不变。
 *
 * 但它确实改变了 ADR-0015 的 deposit-only 硬边界，需求方已明确授权修改该约束。
 * 新边界见 ADR-0024；在 G5 通过前，接口仍然固定拒绝。
 */
export const FUNDS_OUTBOUND = Object.freeze({
  /** 产品上已确认要做；能否实际发起出金另由 G5 与 named gate 控制。 */
  productApproved: true,
  scope: "platform_service_balance" as const,
  /** 明确不包含：从客户交易所账户提现（INV-11 永久禁止）。 */
  includesExchangeAccountWithdrawal: false,
  networks: Object.freeze(["usdt_trc20", "usdt_erc20", "usdt_bep20"] as const),
  singleLimitUsdt: "10000",
  dailyLimitUsdt: "100000",
  requiresAddressAllowlist: true,
  addressCoolingPeriodHours: 24,
  requiresMakerChecker: true,
  /** 服务费 0%，链上手续费据实透传。 */
  serviceFeeRate: "0",
  passThroughChainFee: true,
  feeOperatorConfigurable: true,
  /**
   * 确认单写的是「分公司总经理权限一级」。资金相关变更按 INV-3 必须双人复核，
   * 因此该角色是**发起**费率变更的最低权限，批准仍需另一个人。
   */
  feeMinimumRole: "branch_general_manager" as const,
  feeChangeRequiresMakerChecker: true,
});

/** P-10：先按现有品牌色派生三浅三深，设计稿到位后替换配色；默认 Riverton 并跟随系统明暗。 */
export const THEMES = Object.freeze({
  families: Object.freeze(["riverton", "neutral", "high-contrast"] as const),
  modes: Object.freeze(["system", "light", "dark"] as const),
  light: Object.freeze(["riverton-light", "neutral-light", "high-contrast-light"] as const),
  dark: Object.freeze(["riverton-dark", "neutral-dark", "high-contrast-dark"] as const),
  defaultFamily: "riverton" as const,
  defaultMode: "system" as const,
  derivedFromBrandTokens: true,
  awaitingDesignAssets: true,
});

/** P-11：维持现有三域名并立即冻结。 */
export const DOMAINS = Object.freeze({
  client: "agentnovas.com",
  operations: "zht.agentnovas.com",
  maintenance: "xm.agentnovas.com",
  frozen: true,
  frozenAt: "2026-08-24",
});

/** P-12：不设日期，按 Gate 推进。 */
export const DELIVERY_MILESTONES = Object.freeze({
  dateDriven: false,
  gateDriven: true,
  milestones: Object.freeze([
    { id: "M1", scope: "Phase 1–3" },
    { id: "M2", scope: "Phase 4" },
    { id: "M3", scope: "Phase 5 单 provider" },
    { id: "M4", scope: "Phase 6/7/8" },
    { id: "M5", scope: "Phase 9" },
  ] as const),
});

/**
 * A-01：第 6 台设备自动踢掉最久未使用的那台。
 *
 * 这是需求方在「拒绝登录」与「自动挤出」之间的选择，代价是被踢的人可能不知情。因此
 * 通知不是可选项：被踢设备必须同时收到站内与 Email 安全通知，否则「悄悄掉线」会变成
 * 一个无法自查的账号安全盲区。
 */
export const DEVICE_SESSION_POLICY = Object.freeze({
  maximumDevices: 5,
  overflowBehaviour: "evict_least_recently_used" as const,
  notifiesEvictedDevice: true,
  notificationChannels: Object.freeze(["in_app", "email"] as const),
});

/** A-02：异地提醒按网络地址段变化判定，不引入第三方定位。 */
export const LOGIN_LOCATION_PRECISION = Object.freeze({
  precision: "network_segment" as const,
  usesGeolocationDatabase: false,
  usesThirdPartyGeolocation: false,
});

/** A-03：只有客户端多语言；系统邮件统一英语。 */
export const LOCALE_SCOPE = Object.freeze({
  multilingualAudiences: Object.freeze(["client"] as const),
  internalAudienceLocale: "zh-CN" as const,
  emailLocale: "en-US" as const,
  supportedLocales: Object.freeze([
    "en-US", "zh-CN", "zh-TW", "ru-RU", "es-ES", "ja-JP", "ko-KR",
  ] as const),
  defaultLocale: "en-US" as const,
});

/**
 * 参数虽已冻结，但两项改变了既有硬边界，实施前必须先有 ADR：
 * 这个清单让「改了边界却没写 ADR」变成可被测试断言的缺失。
 */
export const BOUNDARY_CHANGES_REQUIRING_ADR = Object.freeze([
  {
    parameter: "P-09",
    change: "平台服务余额提现改变 ADR-0015 的 deposit-only 硬边界",
    adr: "0024",
  },
  {
    parameter: "A-01",
    change: "第 6 台设备从拒绝登录改为自动挤出，改变 ADR-0022 的待确认项",
    adr: "0024",
  },
] as const);
