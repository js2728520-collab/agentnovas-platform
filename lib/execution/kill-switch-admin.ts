/**
 * 熔断开关的运维端入口。
 *
 * 仓储层收 `Queryable`，便于用独立 schema 做真实数据库测试；这一层把它接到
 * Web 进程自己的连接池上，让路由不必关心连接从哪来。
 */

import { getPostgresPool } from "../postgres.ts";
import {
  applyKillSwitchRelease as applyRelease,
  engageKillSwitch as engage,
  listKillSwitches as list,
  requestKillSwitchRelease as requestRelease,
  type KillSwitchRow,
} from "./kill-switch-repository.ts";
import type { KillSwitchDimension } from "../../packages/domain/src/execution/kill-switch.ts";

export type { KillSwitchRow };

export async function engageKillSwitch(input: {
  dimension: KillSwitchDimension;
  scopeValue: string;
  reason: string;
  engagedBy: string;
}) {
  return engage(await getPostgresPool(), input);
}

export async function listKillSwitches(options: { activeOnly?: boolean; limit?: number } = {}) {
  return list(await getPostgresPool(), options);
}

export async function requestKillSwitchRelease(input: {
  id: string;
  requestedBy: string;
  approvalRequestId: string;
}) {
  return requestRelease(await getPostgresPool(), input);
}

export async function applyKillSwitchRelease(input: { id: string; releasedBy: string }) {
  return applyRelease(await getPostgresPool(), input);
}
