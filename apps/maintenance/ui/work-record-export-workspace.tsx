"use client";

import { useRef, useState } from "react";

import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type ExportResult = {
  period: { from: string; to: string; timezone: "UTC" };
  generatedAt: string;
  limit: number;
  truncated: boolean;
  data: unknown[];
};

function currentUtcRange() {
  const to = new Date();
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  const start = new Date(end.getTime() - 6 * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function apiMessage(value: unknown, fallback: string, useServerMessage: boolean) {
  if (!value || typeof value !== "object" || !useServerMessage) return fallback;
  const error = (value as { error?: unknown }).error;
  return error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : fallback;
}

export function WorkRecordExportWorkspace() {
  const { locale, t } = useAppLocale();
  const [defaults] = useState(currentUtcRange);
  const retryBinding = useRef<{ signature: string; key: string } | null>(null);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExportResult | null>(null);

  function updateField(change: () => void) {
    retryBinding.current = null;
    setResult(null);
    setError("");
    change();
  }

  async function exportRecords(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = { from, to };
    const signature = JSON.stringify(body);
    if (!retryBinding.current || retryBinding.current.signature !== signature) {
      retryBinding.current = { signature, key: `work-record-export:${crypto.randomUUID()}` };
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/maintenance/work-records/export", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": retryBinding.current.key,
        },
        body: signature,
      });
      const text = await response.text();
      const payload = JSON.parse(text) as ExportResult | { error?: unknown };
      if (!response.ok) throw new Error(apiMessage(payload, t("工作记录导出失败"), locale === "zh-CN"));
      const report = payload as ExportResult;
      const disposition = response.headers.get("content-disposition") || "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `strategy-work-records-${from}-${to}.json`;
      const objectUrl = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      retryBinding.current = null;
      setResult(report);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("工作记录导出失败"));
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(from && to && !busy);
  return <>
    <PageHeading
      eyebrow="CONTROLLED WORK-RECORD EXPORT"
      title={t("工作记录脱敏导出")}
      description={t("只导出安全视图中的伪名客户与业务白名单字段；不包含原始用户 ID、客户资料、模型内容、错误原文或任何凭证。")}
    />
    <section className="rc-panel" aria-labelledby="work-record-export-title">
      <header><div><small>UTC · MAX 31 DAYS · MAX 1,000 ROWS</small><h2 id="work-record-export-title">{t("导出范围")}</h2><p>{t("提交后直接生成脱敏 JSON；操作者、范围、请求标识和结果由服务端自动留痕。")}</p></div><StatusBadge value={t("敏感权限")} /></header>
      <form className="rc-filter-grid" onSubmit={exportRecords}>
        <label>{t("开始日期（UTC）")}<input required type="date" value={from} max={to} onChange={(event) => updateField(() => setFrom(event.target.value))} /></label>
        <label>{t("结束日期（UTC）")}<input required type="date" value={to} min={from} onChange={(event) => updateField(() => setTo(event.target.value))} /></label>
        <div className="rc-action-row"><button className="rc-primary" type="submit" disabled={!ready}>{busy ? t("正在生成…") : t("生成并下载脱敏 JSON")}</button></div>
      </form>
      <div className="rc-live" aria-live="polite" aria-atomic="true">
        {busy ? <p>{t("正在查询安全投影并写入追加式审计…")}</p> : null}
        {error ? <p role="alert">{error}；{t("保持原条件重试会复用同一 Idempotency-Key。")}</p> : null}
        {result ? <p>{t("已导出")} {result.data.length} {t("条记录。")} {result.truncated ? `${t("结果已达到")} ${result.limit} ${t("条上限，请缩小日期范围继续导出。")}` : t("当前范围未截断。")}</p> : null}
      </div>
    </section>
    <section className="rc-panel" aria-labelledby="work-record-export-boundary">
      <header><div><small>SECURITY BOUNDARY</small><h2 id="work-record-export-boundary">{t("导出边界")}</h2></div></header>
      <ul>
        <li>{t("Maintenance 数据库角色只能读取 security-barrier 安全视图，不能读取客户工作记录原表。")}</li>
        <li>{t("相同人员与 Idempotency-Key 的重放返回同一结果，只产生一条审计事件。")}</li>
        <li>{t("服务端不向文件系统或对象存储落导出文件；为保证安全重放，脱敏响应仅保存在不可变幂等终态记录中。")}</li>
        <li>{t("真实订单路由保持关闭，导出不会调用 LLM、生成策略或触发任何交易。")}</li>
      </ul>
    </section>
  </>;
}
