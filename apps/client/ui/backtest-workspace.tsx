"use client";

/**
 * 策略回测工作区。
 *
 * 已保存策略的可配置历史回测：选择策略、设定预设与成本参数、运行、看报告。
 * 后端一直完整（/api/strategy-marketplace/[id]/backtest，NDJSON 流式阶段进度），
 * 但入口此前只存在于遗留 SPA 的问卷表单里，那个表单在 P4 被删除后就失去了入口。
 * 这里把它接回真实路由：列表 /backtests，单策略 /backtests/:id。
 *
 * 与 /studio 的分工：studio 是**产生**策略（多智能体研发流水线，自带训练/验证集
 * 切分与确定性准入）；这里是对**已保存**的策略按自选参数复算，用于解读与对比。
 */

import { useCallback, useEffect, useState } from "react";

import { ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { clientErrorMessage, clientRequest } from "./client-api";
import { StrategyBacktestCenter, type StrategyBacktestSummary } from "./strategy-backtest-center";
import { StrategyBacktestDetail } from "./strategy-backtest-detail";

type MarketplaceRow = {
  id: string;
  name: string;
  version: number;
  status: string;
  symbols?: string[];
  createdAt?: string;
};

export default function BacktestWorkspace({ strategyId }: { strategyId?: string }) {
  const [strategies, setStrategies] = useState<StrategyBacktestSummary[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const payload = await clientRequest<{ mine: MarketplaceRow[] }>(
        "/api/strategy-marketplace",
        { cache: "no-store" },
        "策略列表读取失败",
      );
      setStrategies((payload.mine ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        symbols: row.symbols ?? [],
        status: row.status,
        createdAt: row.createdAt,
      })));
      setError("");
    } catch (loadError) {
      setError(clientErrorMessage(loadError, "策略列表读取失败"));
    }
  }, []);

  // 首次加载推出 effect 的同步阶段：effect 内同步 setState 会触发级联渲染。
  // 与 trading-experience.tsx 用同一个写法。
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (error) return <ErrorState message={error} retry={() => void load()} />;
  if (!strategies) return <LoadingState label="正在读取已保存的策略…" />;

  const go = (path: string) => window.location.assign(path);

  if (strategyId) {
    return <StrategyBacktestDetail
      strategyId={strategyId}
      onBack={() => go("/backtests")}
      onUpdated={() => void load()}
    />;
  }
  return <StrategyBacktestCenter
    strategies={strategies}
    onBack={() => go("/studio")}
    onOpenDetail={(id) => go(`/backtests/${encodeURIComponent(id)}`)}
    onUpdated={() => void load()}
  />;
}
