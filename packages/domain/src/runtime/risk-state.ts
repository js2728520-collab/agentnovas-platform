/**
 * 运行时风控读数的归一化。
 *
 * 风控读数存在 strategy_deployments.risk_state_json 里，类型是 jsonb——
 * 数据库不保证里面是什么。域层必须把它变成可信的数字，或者明确说「不可信」。
 *
 * 失败安全（INV-7）：读数损坏时不猜 0。
 *
 * 这是刻意的行为变更。此前的写法是：
 *
 *     drawdownPct: Number.isFinite(drawdownPct) ? Math.max(drawdownPct, 0) : 0
 *
 * 回撤取 0 的含义是「账户从未亏损」，风控因此看到一个完美健康的账户并放行开仓。
 * 也就是说读数越坏，越容易开仓——方向和失败安全相反，而且悄无声息。
 *
 * 现在损坏的字段名会记进 unavailableFields，引擎据此拒绝**开仓**并写明理由。
 * 平仓不受影响：引擎里所有风控检查都只作用于开仓，
 * `riskApproved = action === "exit" || action === "hold" || 无拒绝理由`。
 * 所以这条规则不会把客户困在仓位里。
 */

export type RuntimeRiskState = {
  drawdownPct: number;
  dailyLossPct: number;
  consecutiveLosses: number;
  halted: boolean;
  /** 读数损坏的字段名，已排序。非空表示风控状态不可信。 */
  unavailableFields: string[];
};

/** 缺失与损坏是两回事，见 resolveRuntimeRiskState 的注释。 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

export function resolveRuntimeRiskState(raw: Record<string, unknown>): RuntimeRiskState {
  const unavailableFields: string[] = [];

  // 缺失按 0 处理，损坏才算不可用。
  //
  // 0007 号迁移给 risk_state_json 的默认值是
  // {"drawdownPct":0,"dailyLossPct":0,"consecutiveLosses":0,"halted":false}，
  // 列是 NOT NULL。所以字段缺失只可能出现在从未写入的新部署上，
  // 而新部署的回撤确实是 0——这是真实读数，不是猜的。
  //
  // 「present but garbage」才是危险情况：说明有人算出了一个值，而这个值是错的。
  const readNumber = (field: string, integerOnly = false) => {
    const value = raw[field];
    if (isAbsent(value)) return 0;
    // 只接受数字与非空数字字符串。不能直接用 Number()——
    // Number([]) === 0、Number(false) === 0、Number("") === 0，
    // 这些明显损坏的值会被悄悄变成「没有回撤」，正是要挡掉的失败方向。
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
    const usable = integerOnly ? Number.isInteger(parsed) : Number.isFinite(parsed);
    if (!usable) {
      unavailableFields.push(field);
      return 0;
    }
    // 负值夹到 0：权益高于峰值时回撤算出来可能是极小的负数，这是舍入，不是损坏。
    return Math.max(parsed, 0);
  };

  const drawdownPct = readNumber("drawdownPct");
  const dailyLossPct = readNumber("dailyLossPct");
  const consecutiveLosses = readNumber("consecutiveLosses", true);

  return {
    drawdownPct,
    dailyLossPct,
    consecutiveLosses,
    // halted 一直是失败安全的：只有显式的 true 才算熔断，其它一律视为未熔断。
    // 这里不改——它和 unavailableFields 是两回事，混在一起会让运营端看到
    // 「已触发熔断」而实际上只是读数坏了。
    halted: raw.halted === true,
    unavailableFields: unavailableFields.sort(),
  };
}
