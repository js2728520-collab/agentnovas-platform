"use client";

import Link from "next/link";

import type { PaperPortfolio } from "@/packages/contracts/src/commercial-beta";
import { formatDateTime, hasAnyPermission, type EffectiveAccessPayload } from "@/packages/contracts/src/riverton-ui";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import { derivePaperPortfolioSummary } from "./client-home-model";
import styles from "./client-home-workspace.module.css";

const strategyLabels = {
  ai_conservative: "AI 稳健型",
  ai_balanced: "AI 平衡型",
  ai_aggressive: "AI 激进型",
} as const;
const portfolioStatusLabels = { ACTIVE: "可开仓", CLOSE_ONLY: "仅平仓", READ_ONLY: "只读" } as const;
const runtimeLabels = { NOT_STARTED: "未启动", ACTIVE: "运行中", PAUSED: "已暂停", ENDED: "已结束", FAILED: "异常" } as const;

function money(value: number | string, locale: string) {
  const parsed = Number(value);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(parsed) ? parsed : 0);
}

function pnlClass(value: number | string) {
  return Number(value) < 0 ? styles.negative : styles.positive;
}

export function ClientHomeWorkspace({ access }: { access: EffectiveAccessPayload }) {
  const { locale, t } = useAppLocale();
  const canViewPaper = hasAnyPermission(access.permissions, ["client.paper.view"]);
  const paper = useApiData<{ data: PaperPortfolio[] }>(canViewPaper ? "/api/trading-hall/paper/portfolio" : null, t("模拟组合读取失败"));
  const portfolios = paper.data?.data ?? [];
  const summary = derivePaperPortfolioSummary(portfolios);
  const totalPnl = summary.realizedNetPnlUsdt + summary.unrealizedPnlUsdt;

  return <div className={styles.dashboard}>
    <header className={styles.pageHeading}>
      <div><h1>{t("数据看板")}</h1><p>{t("当前账户的模拟组合收益、持仓和策略状态。")}</p></div>
      <div className={styles.headingMeta}><span className={styles.paperBadge}>{t("Paper 模拟数据")}</span>{summary.latestUpdatedAt && <time dateTime={summary.latestUpdatedAt}>{t("更新于")} {formatDateTime(summary.latestUpdatedAt, locale)}</time>}</div>
    </header>

    {!canViewPaper ? <section className={styles.state} role="status"><h2>{t("暂无组合数据")}</h2><p>{t("当前账户没有查看模拟组合的权限。")}</p></section>
      : paper.error ? <section className={styles.state} role="alert"><h2>{t("组合数据读取失败")}</h2><p>{paper.error}</p><button type="button" onClick={paper.refresh}>{t("重新读取")}</button></section>
        : paper.loading || !paper.data ? <section className={styles.loading} aria-label={t("数据看板加载中")} aria-busy="true"><i /><i /><i /><i /></section>
          : portfolios.length === 0 ? <section className={styles.state} role="status"><h2>{t("尚无模拟组合")}</h2><p>{t("会员权益生效后，服务端会创建对应的官方策略组合。")}</p></section>
            : <>
              <section className={styles.summaryGrid} aria-label={t("组合核心数据")}>
                <article className={styles.primaryMetric}><span>{t("组合总权益")}</span><strong>{money(summary.totalEquityUsdt, locale)} <small>USDT</small></strong><p>{portfolios.length} {t("个模拟组合")}</p></article>
                <article><span>{t("累计收益")}</span><strong className={pnlClass(totalPnl)}>{money(totalPnl, locale)} <small>USDT</small></strong><p>{t("已实现与未实现收益合计")}</p></article>
                <article><span>{t("当前持仓")}</span><strong>{summary.totalOpenPositionCount}</strong><p>{t("所有策略的未平仓仓位")}</p></article>
                <article><span>{t("需关注组合")}</span><strong className={summary.attentionPortfolioCount ? styles.attention : undefined}>{summary.attentionPortfolioCount}</strong><p>{t("只读、仅平仓、暂停或异常")}</p></article>
                <article><span>{t("运行中策略")}</span><strong>{summary.runningStrategyCount}</strong><p>{summary.activePortfolioCount} {t("个组合允许新开仓")}</p></article>
              </section>

              <section className={styles.strategySection} aria-labelledby="strategy-performance-title">
                <header><div><h2 id="strategy-performance-title">{t("策略状态与最近活动")}</h2><p>{t("数据来源：模拟组合 · 口径：当前账户三张官方 Paper 策略。")}</p></div><Link href="/trading?tab=portfolios">{t("查看全部组合")}</Link></header>
                <div className={styles.strategyGrid}>{portfolios.map((portfolio) => {
                  const strategyPnl = Number(portfolio.realizedNetPnlUsdt) + Number(portfolio.unrealizedPnlUsdt);
                  return <Link href={`/trading?tab=portfolios&portfolio=${encodeURIComponent(portfolio.id)}`} className={styles.strategyCard} key={portfolio.id}>
                    <header><h3>{t(strategyLabels[portfolio.strategyCode])}</h3><span>{t(portfolioStatusLabels[portfolio.status])}</span></header>
                    <dl>
                      <div><dt>{t("组合权益")}</dt><dd>{money(portfolio.equityUsdt, locale)} <small>USDT</small></dd></div>
                      <div><dt>{t("累计收益")}</dt><dd className={pnlClass(strategyPnl)}>{money(strategyPnl, locale)}</dd></div>
                      <div><dt>{t("当前持仓")}</dt><dd>{portfolio.openPositionCount}</dd></div>
                    </dl>
                    <footer><span>{t(runtimeLabels[portfolio.runtime.state])}</span><span>{portfolio.runtime.lastDecisionAt ? `${t("最近决策")} ${formatDateTime(portfolio.runtime.lastDecisionAt, locale)}` : t("暂无决策")}</span></footer>
                  </Link>;
                })}</div>
              </section>
            </>}

    <p className={styles.disclaimer}>{t("所有权益、持仓和收益均为 Paper 模拟结果，不代表真实或未来收益。")}</p>
  </div>;
}
