/**
 * 跟单生命周期与四方停止（T4.4 / PRD 6.6）。
 *
 * PRD 6.6 要求四方都能暂停或终止异常策略：**用户本人、获授权运营风控角色、系统自动风控、
 * 全局熔断**。四方不是四个按钮，而是四种不同的权威——关键在于**谁停的决定谁能恢复**。
 *
 * 此前订阅只有 pending/active/paused/ended 四个状态，没有任何地方记录是谁停的。后果是
 * 客户可以自己恢复一个被风控停掉的跟随：风控判定形同虚设，而界面上完全看不出异常。
 */

export const FOLLOW_LIFECYCLE_STATES = [
  /** 客户正在填参数，尚未确认。 */
  "configuring",
  /** 客户已确认参数与风险披露，等待首个决策周期。 */
  "user_confirmed",
  /** 运行中。 */
  "active",
  /** 暂停，可恢复。恢复权限取决于是谁暂停的。 */
  "paused",
  /** 被风控或熔断阻断。客户不能自行恢复。 */
  "risk_blocked",
  /** 终止。终态。 */
  "stopped",
] as const;

export type FollowLifecycleState = (typeof FOLLOW_LIFECYCLE_STATES)[number];

/** 四方权威。顺序即优先级：越靠后越强，强者可以覆盖弱者的停止。 */
export const STOP_AUTHORITIES = [
  "customer",
  "operations_risk",
  "automated_risk",
  "global_circuit_breaker",
] as const;

export type StopAuthority = (typeof STOP_AUTHORITIES)[number];

const AUTHORITY_RANK: Record<StopAuthority, number> = {
  customer: 0,
  operations_risk: 1,
  automated_risk: 2,
  global_circuit_breaker: 3,
};

/** 四方里哪些属于风控性质——它们的暂停落到 risk_blocked 而不是 paused。 */
const RISK_AUTHORITIES: readonly StopAuthority[] = ["operations_risk", "automated_risk", "global_circuit_breaker"];

export function isFollowLifecycleState(value: unknown): value is FollowLifecycleState {
  return typeof value === "string" && (FOLLOW_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isStopAuthority(value: unknown): value is StopAuthority {
  return typeof value === "string" && (STOP_AUTHORITIES as readonly string[]).includes(value);
}

export type FollowLifecycleResult =
  | { allowed: true; nextState: FollowLifecycleState; pausedBy: StopAuthority | null }
  | { allowed: false; reason: "unknown_state" | "unknown_authority" | "transition_not_allowed" | "insufficient_authority" };

/**
 * 暂停。
 *
 * 客户暂停落到 `paused`；三种风控性质的权威落到 `risk_blocked`——两者的差别不是措辞，
 * 而是谁能恢复。把风控阻断记成普通暂停，客户下一秒就能自己点恢复。
 */
export function pauseFollow(current: unknown, authority: unknown): FollowLifecycleResult {
  if (!isFollowLifecycleState(current)) return { allowed: false, reason: "unknown_state" };
  if (!isStopAuthority(authority)) return { allowed: false, reason: "unknown_authority" };
  if (current === "stopped") return { allowed: false, reason: "transition_not_allowed" };
  if (current === "configuring") return { allowed: false, reason: "transition_not_allowed" };
  const riskDriven = RISK_AUTHORITIES.includes(authority);
  return {
    allowed: true,
    nextState: riskDriven ? "risk_blocked" : "paused",
    pausedBy: authority,
  };
}

/**
 * 恢复。
 *
 * **谁停的决定谁能恢复。** 恢复方的权威必须不低于暂停方——否则客户可以自己解除风控阻断，
 * 而运营也可以解除全局熔断对单个跟随的影响。这是整个模块存在的理由。
 */
export function resumeFollow(
  current: unknown,
  input: { pausedBy: unknown; authority: unknown },
): FollowLifecycleResult {
  if (!isFollowLifecycleState(current)) return { allowed: false, reason: "unknown_state" };
  if (!isStopAuthority(input.authority)) return { allowed: false, reason: "unknown_authority" };
  if (current !== "paused" && current !== "risk_blocked") {
    return { allowed: false, reason: "transition_not_allowed" };
  }
  // pausedBy 缺失时按最强权威处理：来历不明的停止不该被最弱的一方解除。
  const blocker: StopAuthority = isStopAuthority(input.pausedBy) ? input.pausedBy : "global_circuit_breaker";
  if (AUTHORITY_RANK[input.authority] < AUTHORITY_RANK[blocker]) {
    return { allowed: false, reason: "insufficient_authority" };
  }
  return { allowed: true, nextState: "active", pausedBy: null };
}

/**
 * 终止。终态，任何一方都可以，且不需要先暂停。
 *
 * 终止不设权威门槛：让客户在风控阻断期间也能彻底停掉跟随，是比「保持阻断」更安全的方向
 * ——把人困在一个他想退出的仓位里，不是风控的目的。
 */
export function stopFollow(current: unknown, authority: unknown): FollowLifecycleResult {
  if (!isFollowLifecycleState(current)) return { allowed: false, reason: "unknown_state" };
  if (!isStopAuthority(authority)) return { allowed: false, reason: "unknown_authority" };
  if (current === "stopped") return { allowed: false, reason: "transition_not_allowed" };
  return { allowed: true, nextState: "stopped", pausedBy: null };
}

/** 客户确认参数与披露之后进入等待，首个决策周期把它转成 active。 */
export function confirmFollow(current: unknown): FollowLifecycleResult {
  if (!isFollowLifecycleState(current)) return { allowed: false, reason: "unknown_state" };
  if (current !== "configuring") return { allowed: false, reason: "transition_not_allowed" };
  return { allowed: true, nextState: "user_confirmed", pausedBy: null };
}

export function activateFollow(current: unknown): FollowLifecycleResult {
  if (!isFollowLifecycleState(current)) return { allowed: false, reason: "unknown_state" };
  if (current !== "user_confirmed") return { allowed: false, reason: "transition_not_allowed" };
  return { allowed: true, nextState: "active", pausedBy: null };
}

/** 该跟随此刻是否应当产生新开仓。风控阻断与暂停都不产生，终止更不产生。 */
export function followAllowsNewEntry(state: FollowLifecycleState): boolean {
  return state === "active";
}
