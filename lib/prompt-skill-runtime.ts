import type { Pool, PoolClient } from "pg";

import { isPromptConfigurationKey, normalizePromptConfigurationV1 } from "./prompt-skill-configuration.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type PinnedPromptConfiguration = {
  configurationVersionId: string;
  payloadSha256: string;
  instruction: string;
};

type GatewayRow = {
  configuration_version_id: string;
  payload_json: unknown;
  payload_sha256: string;
};

function instructionFrom(payload: unknown): string {
  // 复用 PS1 的规范化：运行时不得比写入时宽松，否则一份写不进去的 payload 反而能被
  // 执行。安全包络的拒绝规则也在这条路径上再跑一次。
  return normalizePromptConfigurationV1(payload).instruction;
}

/**
 * 读取某个 Prompt 角色**当前生效**的配置版本，用于入队时固定（PS-05）。
 *
 * 返回 null 表示该角色没有已激活的配置版本——此时任务使用代码内定义的 Prompt。
 * 这是当前的真实状态，不是缺陷：把它当成错误会让整条解释链在配置就位前先停摆。
 */
export async function loadActivePromptConfiguration(
  database: Queryable,
  configurationKey: string,
): Promise<PinnedPromptConfiguration | null> {
  if (!isPromptConfigurationKey(configurationKey)) {
    throw new ResearchApiError("PROMPT_CONFIGURATION_KEY_UNKNOWN", "未登记的 Prompt 配置键", 404);
  }
  let rows: GatewayRow[];
  try {
    const result = await database.query<GatewayRow>(
      "SELECT configuration_version_id, payload_json, payload_sha256 FROM prompt_configuration_active($1)",
      [configurationKey],
    );
    rows = result.rows;
  } catch {
    // 网关不可用时回落到代码内 Prompt，而不是让解释任务全部失败。解释是只读的旁路
    // 产物（INV-1：它不参与任何决策），停掉它换不来任何安全收益。
    return null;
  }
  const row = rows[0];
  if (!row) return null;
  return {
    configurationVersionId: row.configuration_version_id,
    payloadSha256: row.payload_sha256,
    instruction: instructionFrom(row.payload_json),
  };
}

/**
 * 按版本 ID 读取任务当初固定的那一份配置（PS-05）。
 *
 * 与 `loadActivePromptConfiguration` 的区别正是这个切片的全部意义：这里**不看当前
 * 生效的是哪一版**。激活或回滚发生在任务入队之后，任务仍按原版执行。
 *
 * 摘要不符一律拒绝执行。payload 能被改写而任务照跑，等于「固定」只是个装饰——
 * 历史解释会声称自己用了某一版，实际用的是被改过的内容。
 */
export async function loadPinnedPromptConfiguration(
  database: Queryable,
  input: { configurationVersionId: string; payloadSha256: string },
): Promise<PinnedPromptConfiguration> {
  const result = await database.query<GatewayRow>(
    "SELECT configuration_version_id, payload_json, payload_sha256 FROM prompt_configuration_pinned($1)",
    [input.configurationVersionId],
  );
  const row = result.rows[0];
  // 读不到的两种原因合并成同一个错误：版本不存在，或它从未被激活过（网关只返回激活过
  // 的版本，未获批的草稿一律读不到）。区分开对调用方没有用处，却会泄露草稿是否存在。
  if (!row) {
    throw new ResearchApiError(
      "PROMPT_CONFIGURATION_PIN_UNAVAILABLE",
      "任务固定的 Prompt 配置版本不可用",
      409,
    );
  }
  if (row.payload_sha256 !== input.payloadSha256) {
    throw new ResearchApiError(
      "PROMPT_CONFIGURATION_PIN_MISMATCH",
      "任务固定的 Prompt 配置摘要与库中记录不一致",
      409,
    );
  }
  return {
    configurationVersionId: row.configuration_version_id,
    payloadSha256: row.payload_sha256,
    instruction: instructionFrom(row.payload_json),
  };
}

/**
 * 为一次研发运行拍下所有研发角色当前生效的 Prompt 配置版本（PS-05）。
 *
 * 与 `snapshotAgentRoleBindings` 同一时机、同一理由：运行创建时把依据固定下来，之后
 * 的激活或回滚不改变这次运行。没有已激活配置的角色不出现在快照里——缺席表示「用代码
 * 内定义」，不是「查不到」。
 */
export async function snapshotResearchPromptConfigurations(
  database: Queryable,
  roles: readonly string[],
): Promise<Record<string, { configurationVersionId: string; payloadSha256: string }>> {
  const snapshot: Record<string, { configurationVersionId: string; payloadSha256: string }> = {};
  for (const role of roles) {
    const active = await loadActivePromptConfiguration(database, `research.${role}`);
    if (!active) continue;
    snapshot[role] = {
      configurationVersionId: active.configurationVersionId,
      payloadSha256: active.payloadSha256,
    };
  }
  return snapshot;
}
