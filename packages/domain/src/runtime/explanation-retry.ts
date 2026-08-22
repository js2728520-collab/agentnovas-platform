/**
 * 运行时解释任务的失败分类与重试节奏。
 *
 * 解释任务调用 LLM 生成人类可读的决策说明。它失败**不影响决策本身**——
 * 决策由确定性代码产出（INV-1），解释只是事后叙述。所以这里的策略是重试，
 * 不是熔断。
 */

export type ExplanationFailureCode =
  | "RUNTIME_EXPLANATION_TIMEOUT"
  | "RUNTIME_EXPLANATION_PROMPT_MISMATCH"
  | "RUNTIME_EXPLANATION_FAILED";

/**
 * 按错误消息分类。
 *
 * 靠消息文本匹配是脆弱的，但改成错误码要动 runtime-explanations 的调用链，
 * 属于行为变更，不放在搬迁批次里做。搬过来是为了让这套分类可以被直接断言，
 * 从而在改写消息时立刻发现分类失效。
 */
export function classifyExplanationFailure(message: string): ExplanationFailureCode {
  if (/超时/.test(message)) return "RUNTIME_EXPLANATION_TIMEOUT";
  if (/Prompt 版本/.test(message)) return "RUNTIME_EXPLANATION_PROMPT_MISMATCH";
  return "RUNTIME_EXPLANATION_FAILED";
}

/** 指数退避：15 秒起步翻倍，封顶 5 分钟。attemptCount 是已尝试次数（从 1 开始）。 */
export function explanationRetryDelayMs(attemptCount: number) {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(attemptCount - 1, 0));
}
