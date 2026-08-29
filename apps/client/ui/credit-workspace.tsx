"use client";

import type { AiCreditBalance } from "@/packages/contracts/src/commercial-beta";
import { formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ErrorState, LoadingState, PageHeading } from "@/packages/ui/src/page-state";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { useApiData } from "@/packages/ui/src/use-api-data";


export function CreditWorkspace() {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ credits: AiCreditBalance }>("/api/credits/me", t("AI 积分读取失败"));
  const credits = resource.data?.credits;
  return <>
    <PageHeading eyebrow={t("账户权益")} title={t("AI 积分")} description={t("查看可用于 AI 助手和策略研究的积分余额与累计使用情况。")} actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()} disabled={resource.loading}>{t("刷新")}</button>} />
    {resource.loading && !credits ? <LoadingState label={t("正在读取 AI 积分…")} /> : resource.error && !credits ? <ErrorState message={resource.error} retry={resource.refresh} /> : credits ? <>
      <section className="rc-kpi-grid" aria-label={t("AI 积分余额")}>
        <article><small>{t("可用积分")}</small><strong>{credits.available}</strong><span>{t("可立即用于 AI 功能")}</span></article>
        <article><small>{t("处理中")}</small><strong>{credits.reserved}</strong><span>{t("正在执行的请求预计消耗")}</span></article>
        <article><small>{t("累计获得")}</small><strong>{credits.lifetimeGranted}</strong><span>{t("随会员权益发放")}</span></article>
        <article><small>{t("累计使用")}</small><strong>{credits.lifetimeConsumed}</strong><span>{t("历史 AI 功能消耗")}</span></article>
      </section>
      <section className="rc-panel"><header><div><h2>{t("积分说明")}</h2></div></header>
        <p>{t("最后更新：")}{formatDateTime(credits.updatedAt, locale)}</p>
        <div className="rc-callout" role="note">{t("积分只能用于平台 AI 功能，不能充值、提现或兑换为账户余额。积分不足时，相关请求不会开始执行。")}</div>
      </section>
    </> : null}
  </>;
}
