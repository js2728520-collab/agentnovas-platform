/**
 * AI Credits 账本规则。
 *
 * Credits 是客户预付的钱，扣错就是收错钱。这里放的是「一笔变更是否合法、
 * 应该改动多少」的全部算术与状态判定——不碰数据库、不知道 HTTP。
 *
 * 为什么必须抽出来：这些规则此前埋在 lib/ai-credit-service.ts 的 SQL 之间，
 * 唯一的覆盖来自 *-postgres.test.mjs——它们确实会跑（连本地库、建临时 schema），
 * 但每验证一条算术规则都要付出一次建表 + 事务的代价，于是实际只覆盖了主干路径。
 * 「settle 退回额超过预留」「adjust 动了预留」这类形状违例从来没被直接测过，
 * 而它们正是扣错钱的方式。抽出来之后一条规则就是一个断言。
 *
 * 本模块只做判定，不抛业务错误：
 * lib/client-ai-inference-service.ts 依赖 `error.message === "AI_CREDIT_INSUFFICIENT"`
 * 来把余额不足映射成 402，错误身份是生产行为的一部分。域层返回决策，由服务层
 * 抛出既有的错误类型，搬迁因此不改变任何对外行为。
 */

export type CreditMutationType = "grant" | "reserve" | "settle" | "release" | "adjust";

/** 一笔变更对「可用」与「预留」两个余额的改动量。单位是最小 credit，用 bigint 避免浮点。 */
export type CreditDelta = {
  availableDelta: bigint;
  reservedDelta: bigint;
};

export type CreditBalance = {
  available: bigint;
  reserved: bigint;
};

const ZERO = BigInt(0);

/**
 * 变更形状是否符合该类型的语义。
 *
 * 这是 credits 账本的「借贷必平」：每种变更只允许一种资金流向，
 * 形状不对说明调用方算错了方向，宁可拒绝也不能记进账本。
 */
export function isValidCreditMutation(type: CreditMutationType, delta: CreditDelta): boolean {
  const { availableDelta, reservedDelta } = delta;
  switch (type) {
    // 充值/赠送：凭空增加可用余额，不动预留。
    case "grant":
      return availableDelta > ZERO && reservedDelta === ZERO;
    // 预留：可用 → 预留，等额搬运，总量不变。
    case "reserve":
      return availableDelta < ZERO && reservedDelta === -availableDelta;
    // 结算：释放整笔预留，把没用掉的部分退回可用。
    // 第三个条件保证总量只减不增——结算不能凭空造出 credits。
    case "settle":
      return availableDelta >= ZERO && reservedDelta < ZERO && availableDelta + reservedDelta <= ZERO;
    // 释放：预留 → 可用，等额退回，总量不变。
    case "release":
      return availableDelta > ZERO && reservedDelta === -availableDelta;
    // 人工调整：只动可用余额，可正可负，但不能是空操作。
    case "adjust":
      return reservedDelta === ZERO && availableDelta !== ZERO;
  }
}

/**
 * 把变更应用到余额上。
 *
 * 任一余额变负就返回 null——不是「夹到 0」。余额不足是调用方必须显式处理的
 * 结果（INV-7 失败安全），静默降级会让客户在没钱时也调用到模型。
 */
export function applyCreditDelta(balance: CreditBalance, delta: CreditDelta): CreditBalance | null {
  const available = balance.available + delta.availableDelta;
  const reserved = balance.reserved + delta.reservedDelta;
  if (available < ZERO || reserved < ZERO) return null;
  return { available, reserved };
}

// ---------------------------------------------------------------------------
// 预留生命周期
// ---------------------------------------------------------------------------

/** 预留的持久化状态。reserved 是唯一的活动态，另两个是终态。 */
export type ReservationStatus = "reserved" | "settled" | "released";

export type ReservationTransition = "settled" | "released";

/**
 * 一次结算/释放请求该怎么处理。
 *
 * - `proceed`：预留仍活动，正常执行；
 * - `replay`：已处于目标终态，返回上一次的结果（INV-8 要求重试幂等）；
 * - `conflict`：已落到另一个终态。结算一笔已释放的预留是调用方的错，
 *   必须报错而不是补一笔——那会重复扣费。
 */
export function resolveReservationTransition(
  current: ReservationStatus,
  target: ReservationTransition,
): "proceed" | "replay" | "conflict" {
  if (current === target) return "replay";
  if (current === "reserved") return "proceed";
  return "conflict";
}

export type SettlementPlan =
  | { ok: true; delta: CreditDelta; settledCredits: bigint }
  | { ok: false; reason: "EXCEEDS_RESERVATION" };

/**
 * 结算计划：实际用量成本 vs 预留额。
 *
 * 实际超过预留时拒绝，**不自动补扣**。预留额是事前对客户承诺的花费上限，
 * 超出说明用量估算或计价出了问题，应当由人来查，而不是让系统多划一笔。
 */
export function planReservationSettlement(estimated: bigint, actual: bigint): SettlementPlan {
  if (actual > estimated) return { ok: false, reason: "EXCEEDS_RESERVATION" };
  // 负成本不在这里挡：它产生的 delta 会让总量增加，由 isValidCreditMutation 的
  // settle 形状规则拒绝。刻意不重复设防，免得两处规则日后各改各的。
  return {
    ok: true,
    // 退回没用掉的部分，同时清掉整笔预留。
    delta: { availableDelta: estimated - actual, reservedDelta: -estimated },
    settledCredits: actual,
  };
}

/** 释放计划：整笔预留原路退回可用余额。 */
export function planReservationRelease(estimated: bigint): CreditDelta {
  return { availableDelta: estimated, reservedDelta: -estimated };
}
