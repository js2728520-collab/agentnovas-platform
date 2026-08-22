/**
 * 实盘路由授权的运维端入口。把仓储接到 Web 进程自己的连接池上。
 */

import { getPostgresPool } from "../postgres.ts";
import {
  grantLiveRouting as grant,
  listLiveRouting as list,
  requestLiveRouting as request,
  revokeLiveRouting as revoke,
  type LiveRoutingRow,
} from "./live-routing-repository.ts";
import type { ExchangeEnvironment } from "../../packages/domain/src/execution/live-routing.ts";

export type { LiveRoutingRow };

export async function requestLiveRouting(input: {
  exchange: string;
  environment: ExchangeEnvironment;
  requestedBy: string;
  note: string;
  approvalRequestId: string;
}) {
  return request(await getPostgresPool(), input);
}

export async function grantLiveRouting(input: { id: string; grantedBy: string }) {
  return grant(await getPostgresPool(), input);
}

export async function revokeLiveRouting(input: { id: string; revokedBy: string; reason: string }) {
  return revoke(await getPostgresPool(), input);
}

export async function listLiveRouting(options: { limit?: number } = {}) {
  return list(await getPostgresPool(), options);
}
