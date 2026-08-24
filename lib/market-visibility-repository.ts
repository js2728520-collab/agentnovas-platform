import type { Pool, PoolClient } from "pg";

import { MARKET_VISIBILITY_FAMILY, resolveMarketVisibility } from "./market-visibility-configuration.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * 读取当前生效的市场可见性。
 *
 * 走 0077 的 `market_visibility_current` 网关而不是直接读配置表：底表里还有草稿与审批
 * 意见，Web 角色只拿到函数执行权。
 *
 * 查询失败时回落到默认可见，与 `resolveMarketVisibility` 对非法配置的处理一致——把整个
 * 行情页变空白比多显示一个市场严重得多。
 */
export async function loadActiveMarketVisibility(database: Queryable): Promise<Record<string, boolean>> {
  try {
    const result = await database.query<{ payload_json: unknown }>(
      "SELECT payload_json FROM market_visibility_current($1)",
      [MARKET_VISIBILITY_FAMILY.key],
    );
    return resolveMarketVisibility(result.rows[0]?.payload_json ?? null);
  } catch {
    return resolveMarketVisibility(null);
  }
}
