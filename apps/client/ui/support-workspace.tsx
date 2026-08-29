"use client";

import type { PublicPlatformSettings } from "@/lib/platform-settings-contract";
import { EmptyState, ErrorState, LoadingState, PageHeading } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export function SupportWorkspace() {
  const { t } = useAppLocale();
  const settings = useApiData<PublicPlatformSettings>("/api/platform/settings", t("客服与公告读取失败"));
  if (settings.loading && !settings.data) return <LoadingState label="正在读取真实客服渠道…" />;
  if (settings.error && !settings.data) return <ErrorState message={settings.error} retry={settings.refresh} />;
  const system = settings.data?.system;
  const hasChannel = Boolean(system?.supportEmail || system?.telegramSupportUrl);
  return <>
    <PageHeading eyebrow="SUPPORT" title="帮助与支持" description="此处只展示平台已配置的真实联系渠道。请勿发送密码、API Key、恢复码或其他敏感凭证。" />
    {system?.maintenanceBanner && <section className="rc-warning" role="status" aria-live="polite"><strong>{t("平台公告")}</strong><p>{system.maintenanceBanner}</p></section>}
    {hasChannel ? <section className="rc-panel">
      <header><div><small>VERIFIED CHANNELS</small><h2>{t("联系客服")}</h2></div></header>
      <div className="rc-card-grid">
        {system?.supportEmail && <article className="rc-card"><h3>{t("客服邮箱")}</h3><a className="rc-button" href={`mailto:${system.supportEmail}`}>{system.supportEmail}</a></article>}
        {system?.telegramSupportUrl && <article className="rc-card"><h3>Telegram</h3><a className="rc-button" href={system.telegramSupportUrl} target="_blank" rel="noopener noreferrer">{t("打开 Telegram 客服")}</a></article>}
      </div>
      <p className="rc-muted">{t("本页面不生成虚假客服单。联系后请保留邮件或平台会话记录，并在问题描述中附上页面显示的 requestId（如有）。")}</p>
    </section> : <EmptyState title={t("客服渠道未配置")} description={t("此处只展示平台已配置的真实联系渠道。请勿发送密码、API Key、恢复码或其他敏感凭证。")} />}
  </>;
}
