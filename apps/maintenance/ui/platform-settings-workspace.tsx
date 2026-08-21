"use client";

import { useState } from "react";

import { type SystemSettings } from "@/lib/platform-settings-contract";
import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { ErrorState, LoadingState, PageHeading } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type PlatformSettingsResponse = { system: SystemSettings };

export function PlatformSettingsWorkspace() {
  const resource = useApiData<PlatformSettingsResponse>("/api/maintenance/platform-settings", "平台设置读取失败");

  if (resource.loading && !resource.data) return <LoadingState label="正在读取平台公开设置…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message="平台公开设置不可用" retry={resource.refresh} />;
  return <PlatformSettingsEditor key={JSON.stringify(resource.data.system)} initial={resource.data.system} refresh={resource.refresh} />;
}

function PlatformSettingsEditor({ initial, refresh }: { initial: SystemSettings; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<SystemSettings>(initial);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function save(maintenanceReason: string) {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/maintenance/platform-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system: draft, maintenanceReason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "平台设置保存失败"));
      if (payload.system) setDraft(payload.system as SystemSettings);
      setMessage(String(payload.message || "平台公开设置已保存。"));
      setConfirming(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "平台设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return <>
    <PageHeading eyebrow="PUBLIC PLATFORM SETTINGS" title="平台与客服设置" description="维护客户端公开品牌、客服入口和维护公告；敏感配置不在此页面展示。" actions={<button className="rc-button" type="button" onClick={() => void refresh()}>重新读取</button>} />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-panel">
      <header><div><small>客户端公开字段</small><h2>品牌与客服入口</h2></div></header>
      <div className="rc-form rc-form-grid">
        <label>站点名称<input maxLength={80} value={draft.siteName} onChange={(event) => update("siteName", event.target.value)} /></label>
        <label>主域名<input maxLength={160} value={draft.primaryDomain} onChange={(event) => update("primaryDomain", event.target.value)} /></label>
        <label>服务运营方<input maxLength={160} value={draft.serviceOperatorName} onChange={(event) => update("serviceOperatorName", event.target.value)} placeholder="必须由平台负责人明确填写" /></label>
        <label>服务区域<input maxLength={300} value={draft.serviceRegion} onChange={(event) => update("serviceRegion", event.target.value)} placeholder="例如：仅限受邀用户所在的已开放区域" /></label>
        <label>客服邮箱<input type="email" maxLength={254} value={draft.supportEmail} onChange={(event) => update("supportEmail", event.target.value)} placeholder="未配置时客户端会明确说明" /></label>
        <label>Telegram 客服链接<input type="url" maxLength={300} value={draft.telegramSupportUrl} onChange={(event) => update("telegramSupportUrl", event.target.value)} placeholder="https://t.me/riverton_support" /></label>
        <label>版权主体<input maxLength={80} value={draft.copyrightOwner} onChange={(event) => update("copyrightOwner", event.target.value)} /></label>
        <label>默认语言<select value={draft.defaultLocale} onChange={(event) => update("defaultLocale", event.target.value as SystemSettings["defaultLocale"])}><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ru-RU">Русский</option><option value="es-ES">Español</option><option value="ja-JP">日本語</option><option value="ko-KR">한국어</option></select></label>
        <label className="rc-wide-field">维护公告<textarea rows={4} maxLength={500} value={draft.maintenanceBanner} onChange={(event) => update("maintenanceBanner", event.target.value)} placeholder="留空时客户端不显示公告" /><small>{draft.maintenanceBanner.length}/500</small></label>
        <p className="rc-wide-field">服务运营方、服务区域、客服邮箱和主域名会进入商业披露发布快照；任何一项为空都不能发布。Telegram 客服链接仅接受受支持域名的 HTTPS 地址。</p>
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={saving} onClick={() => setConfirming(true)}>{saving ? "正在保存…" : "核对并保存"}</button></div>
      </div>
    </section>
    <section className="rc-panel">
      <header><div><small>客户端预览</small><h2>{draft.siteName || "Riverton Capital"}</h2></div></header>
      <dl className="rc-description-list"><div><dt>客服渠道</dt><dd>{draft.telegramSupportUrl ? "Telegram 已配置" : "Telegram 未配置"}{draft.supportEmail ? ` · ${draft.supportEmail}` : " · 邮箱未配置"}</dd></div><div><dt>维护公告</dt><dd>{draft.maintenanceBanner || "未发布"}</dd></div></dl>
    </section>
    <ConfirmActionDialog open={confirming} title="保存平台与客服设置" description="这些公开字段会影响客户端展示。请记录变更原因，保存结果将进入审计日志。" confirmLabel="确认保存" busy={saving} onCancel={() => setConfirming(false)} onConfirm={(reason) => void save(reason)} />
  </>;
}
