"use client";

import type { PublicPlatformSettings } from "@/lib/platform-settings-contract";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

export function SupportWorkspace() {
  const settings = useApiData<PublicPlatformSettings>("/api/platform/settings", "客服与公告读取失败");
  if (settings.loading && !settings.data) return <LoadingState label="正在读取真实客服渠道…" />;
  if (settings.error && !settings.data) return <ErrorState message={settings.error} retry={settings.refresh} />;
  const system = settings.data?.system;
  const hasChannel = Boolean(system?.supportEmail || system?.telegramSupportUrl);
  return <>
    <PageHeading eyebrow="SUPPORT & ANNOUNCEMENTS" title="支持与公告" description="此处只展示平台已配置的真实联系渠道。请勿发送密码、API Key、恢复码或其他敏感凭证。" actions={<StatusBadge value={hasChannel ? "客服渠道可用" : "客服渠道未配置"} />} />
    {system?.maintenanceBanner ? <section className="rc-warning" role="status" aria-live="polite"><strong>平台公告</strong><p>{system.maintenanceBanner}</p></section> : <section className="rc-panel"><header><div><small>ANNOUNCEMENTS</small><h2>平台公告</h2></div></header><p className="rc-muted">当前没有已发布公告。</p></section>}
    <section className="rc-panel">
      <header><div><small>VERIFIED CHANNELS</small><h2>联系客服</h2></div></header>
      <div className="rc-card-grid">
        <article className="rc-card"><header><StatusBadge value={system?.supportEmail ? "已配置" : "未配置"} /></header><h3>客服邮箱</h3>{system?.supportEmail ? <a className="rc-button" href={`mailto:${system.supportEmail}`}>{system.supportEmail}</a> : <p>客服邮箱尚未配置，请稍后重试。</p>}</article>
        <article className="rc-card"><header><StatusBadge value={system?.telegramSupportUrl ? "已配置" : "未配置"} /></header><h3>Telegram</h3>{system?.telegramSupportUrl ? <a className="rc-button" href={system.telegramSupportUrl} target="_blank" rel="noopener noreferrer">打开 Telegram 客服</a> : <p>Telegram 尚未配置，不提供替代账号或验证码。</p>}</article>
      </div>
      <p className="rc-muted">本页面不生成虚假客服单。联系后请保留邮件或平台会话记录，并在问题描述中附上页面显示的 requestId（如有）。</p>
    </section>
  </>;
}
