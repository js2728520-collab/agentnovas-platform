/**
 * 策略广场上架状态机（T4.2）。
 *
 * 此前状态是一列自由文本，合法迁移散落在六个路由文件里的 `.includes()` 判断中，没有任何
 * 地方写明「有哪些状态」和「哪些迁移合法」。结果之一是 `submitted` 成了死胡同：投稿会创建
 * 一张 `strategy_listing` 审批单，而唯一的审批端点明确拒绝该类型，于是没有任何路径能让策略
 * 走到 `approved`；广场列表查的却是 `listed`。
 *
 * 这里把状态与迁移收敛成一处，数据库的 CHECK 约束与本表由测试对齐。
 */

export const STRATEGY_LISTING_STATES = [
  /** 作者编辑中。 */
  "draft",
  /** 已跑过回测。仍属于作者可编辑阶段，只是多了一份回测事实。 */
  "testing",
  /** 已提交，等待运营认领。 */
  "submitted",
  /** 运营已认领，审核进行中。 */
  "under_review",
  /** 审核通过，尚未上架。 */
  "approved",
  /** 已上架，客户可浏览与跟随。 */
  "listed",
  /** 已下架。终态，不可回到 listed——重新上架要走新版本。 */
  "delisted",
  /** 审核驳回。作者可修改后重新提交。 */
  "rejected",
] as const;

export type StrategyListingState = (typeof STRATEGY_LISTING_STATES)[number];

export type StrategyListingTransition =
  | "run_backtest"
  | "submit"
  | "claim_review"
  | "approve"
  | "reject"
  | "list"
  | "delist"
  | "revise";

/**
 * 合法迁移表。
 *
 * 两条刻意的设计：
 *
 * - **`delisted` 是终态。** 下架后不能直接回到 `listed`——已下架的策略重新上架必须走新
 *   版本重新审核（PRD 6.5：「重大版本更新后重新审核」）。允许原地复活会让「下架」变成
 *   一个可以被悄悄撤销的动作，而跟随者当初正是看着上架状态做的决定。
 * - **`approved` 与 `listed` 分开。** 审核通过不等于已经上架：上架是一个独立动作，
 *   因此「已通过但未上架」是一个可观察的状态，而不是审批事务里的隐含瞬间。
 */
const TRANSITIONS: Readonly<Record<StrategyListingState, Partial<Record<StrategyListingTransition, StrategyListingState>>>> = Object.freeze({
  draft: { run_backtest: "testing", submit: "submitted", revise: "draft" },
  testing: { run_backtest: "testing", submit: "submitted", revise: "draft" },
  submitted: { claim_review: "under_review", reject: "rejected" },
  under_review: { approve: "approved", reject: "rejected" },
  approved: { list: "listed", reject: "rejected", revise: "draft" },
  listed: { delist: "delisted", revise: "draft" },
  delisted: { revise: "draft" },
  rejected: { revise: "draft", run_backtest: "testing", submit: "submitted" },
});

export function isStrategyListingState(value: unknown): value is StrategyListingState {
  return typeof value === "string" && (STRATEGY_LISTING_STATES as readonly string[]).includes(value);
}

export type StrategyListingTransitionResult =
  | { allowed: true; nextState: StrategyListingState }
  | { allowed: false; reason: "unknown_state" | "transition_not_allowed"; allowedTransitions: StrategyListingTransition[] };

export function applyStrategyListingTransition(
  current: unknown,
  transition: StrategyListingTransition,
): StrategyListingTransitionResult {
  if (!isStrategyListingState(current)) {
    // 未知状态不猜。库里出现一个不在表里的值，说明有写入路径绕过了这台状态机。
    return { allowed: false, reason: "unknown_state", allowedTransitions: [] };
  }
  const next = TRANSITIONS[current][transition];
  if (!next) {
    return {
      allowed: false,
      reason: "transition_not_allowed",
      allowedTransitions: Object.keys(TRANSITIONS[current]) as StrategyListingTransition[],
    };
  }
  return { allowed: true, nextState: next };
}

/** 客户能在广场里看到的状态。只有 `listed`——审核中与已下架都不对外可见。 */
export function isPubliclyVisibleListingState(state: StrategyListingState): boolean {
  return state === "listed";
}

/** 作者仍可编辑内容的状态。已提交之后不能再改，否则审核对象会在审核期间变化。 */
export function isAuthorEditableListingState(state: StrategyListingState): boolean {
  return state === "draft" || state === "testing" || state === "rejected";
}
