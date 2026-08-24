import { strategyDslToRuntime } from "./strategy-dsl.ts";

/**
 * 社区策略能否在现货模拟盘上跟随（T4.4 第 1 步）。
 *
 * **现货只能做多**，这不是选择而是现货的定义。社区策略的 DSL 全部按永续编写
 * （V2/V3 硬要求 `market: "usdt_perpetual"`），因此上现货前必须逐条判断：
 *
 * - `long_only` —— 可以忠实运行。
 * - `short_only` —— 根本跑不了。
 * - `both` —— 需求方确认**拒绝跟单**，不做「只跑多头腿」的降级。只跑一半会让客户看到的
 *   结果与作者策略的真实表现不同，而绩效分成正是按这个残缺版本的盈亏算的。
 *
 * 判定是纯函数，且**只回答能不能**，不改写策略。降级执行一个策略等于替作者和客户各自
 * 改了他们同意的东西。
 *
 * **这里不检查杠杆**：V2 与 V3 的 DSL 自己就把 leverage 固定为 1，再加一道检查是够不到的
 * 死代码——一条永远不会触发的守卫看起来和真正起作用的守卫一模一样，留着只会误导。
 * 若将来 DSL 放开杠杆，那道检查要连同测试一起加回来。
 */

export type FollowSpotAdmission =
  | { admitted: true; symbol: string; timeframe: string }
  | { admitted: false; reason: "direction_not_long_only" | "invalid_specification"; detail: string };

export function evaluateFollowSpotAdmission(specification: unknown): FollowSpotAdmission {
  let runtime;
  try {
    runtime = strategyDslToRuntime(specification);
  } catch (error) {
    return {
      admitted: false,
      reason: "invalid_specification",
      detail: (error instanceof Error ? error.message : "策略规格无法解析").slice(0, 160),
    };
  }
  const direction = String((specification as { direction?: unknown })?.direction ?? "");
  if (direction !== "long_only") {
    return {
      admitted: false,
      reason: "direction_not_long_only",
      detail: `现货模拟盘只能做多，该策略的方向是 ${direction || "未声明"}`,
    };
  }
  return { admitted: true, symbol: runtime.symbol, timeframe: runtime.timeframe };
}
