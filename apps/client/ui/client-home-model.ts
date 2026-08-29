import type { PaperPortfolio } from "@/packages/contracts/src/commercial-beta";

type PaperPortfolioSummaryInput = Pick<PaperPortfolio, "equityUsdt" | "realizedNetPnlUsdt" | "unrealizedPnlUsdt" | "openPositionCount" | "status" | "runtime" | "updatedAt">;

export function derivePaperPortfolioSummary(portfolios: PaperPortfolioSummaryInput[]) {
  const decimal = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return portfolios.reduce((summary, portfolio) => {
    const updatedAt = Number.isNaN(Date.parse(portfolio.updatedAt)) ? null : portfolio.updatedAt;
    const attention = portfolio.status !== "ACTIVE" || ["PAUSED", "FAILED"].includes(portfolio.runtime.state);
    return {
      totalEquityUsdt: summary.totalEquityUsdt + decimal(portfolio.equityUsdt),
      realizedNetPnlUsdt: summary.realizedNetPnlUsdt + decimal(portfolio.realizedNetPnlUsdt),
      unrealizedPnlUsdt: summary.unrealizedPnlUsdt + decimal(portfolio.unrealizedPnlUsdt),
      totalOpenPositionCount: summary.totalOpenPositionCount + portfolio.openPositionCount,
      activePortfolioCount: summary.activePortfolioCount + (portfolio.status === "ACTIVE" ? 1 : 0),
      runningStrategyCount: summary.runningStrategyCount + (portfolio.runtime.state === "ACTIVE" ? 1 : 0),
      attentionPortfolioCount: summary.attentionPortfolioCount + (attention ? 1 : 0),
      latestUpdatedAt: updatedAt && (!summary.latestUpdatedAt || updatedAt > summary.latestUpdatedAt) ? updatedAt : summary.latestUpdatedAt,
    };
  }, {
    totalEquityUsdt: 0,
    realizedNetPnlUsdt: 0,
    unrealizedPnlUsdt: 0,
    totalOpenPositionCount: 0,
    activePortfolioCount: 0,
    runningStrategyCount: 0,
    attentionPortfolioCount: 0,
    latestUpdatedAt: null as string | null,
  });
}
