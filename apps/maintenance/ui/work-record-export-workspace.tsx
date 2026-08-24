"use client";

import { useMemo, useState } from "react";

import type { MaintenanceWorkRecordExportResult } from "@/packages/contracts/src/strategy-work-records";
import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";
import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";

const MAX_DAYS = 31;
const REASON_MIN = 3;
const REASON_MAX = 500;

function defaultRange() {
  const today = new Date();
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const from = new Date(to.getTime() - 6 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function inclusiveDays(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

export function WorkRecordExportWorkspace() {
  const [range, setRange] = useState(defaultRange);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MaintenanceWorkRecordExportResult | null>(null);
  // 幂等键在提交时生成并保留：网络结果不确定时重试必须复用同一个键，
  // 否则同一次导出会写两条审计。成功后才轮换。
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const days = useMemo(() => inclusiveDays(range.from, range.to), [range.from, range.to]);
  const reasonLength = reason.trim().length;
  const rangeValid = days !== null && days <= MAX_DAYS;
  const reasonValid = reasonLength >= REASON_MIN && reasonLength <= REASON_MAX;
  const canSubmit = rangeValid && reasonValid && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/maintenance/work-records/export", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ from: range.from, to: range.to, reason: reason.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "导出失败"));
      setResult(payload as MaintenanceWorkRecordExportResult);
      setIdempotencyKey(crypto.randomUUID());
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "导出失败");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading
      eyebrow="WORK RECORDS · CONTROLLED EXPORT"
      title="工作记录导出"
      description="按 UTC 日期导出脱敏的策略决策记录。用户只以单向伪名出现，不含客户 PII、交易所账户、原始证据 JSON、模型名或错误原文。"
    />

    <section className="rc-panel" aria-labelledby="work-record-export-form-title">
      <header>
        <div>
          <small>UTC · 两端包含</small>
          <h2 id="work-record-export-form-title">导出范围与审计原因</h2>
          <p>
            区间最多 {MAX_DAYS} 天，单次最多 1,000 条；命中上限时结果会明确标注不完整。
            填写原因后直接执行，不需要二次确认；每次导出都会写入追加式审计，审计只记录
            日期、条数、截断状态、查询摘要和原因，不记录导出正文。
          </p>
        </div>
        <StatusBadge value="敏感操作" />
      </header>

      <form className="rc-filter-grid" onSubmit={submit}>
        <label>
          开始日期（UTC）
          <input
            required
            type="date"
            value={range.from}
            max={range.to || undefined}
            onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))}
          />
        </label>
        <label>
          结束日期（UTC）
          <input
            required
            type="date"
            value={range.to}
            min={range.from || undefined}
            onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))}
          />
        </label>
        <label>
          审计原因（{REASON_MIN}–{REASON_MAX} 字）
          <input
            required
            type="text"
            value={reason}
            minLength={REASON_MIN}
            maxLength={REASON_MAX}
            placeholder="例如：季度合规抽查"
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="rc-action-row">
          <button className="rc-primary" type="submit" disabled={!canSubmit}>
            {busy ? "正在导出…" : "导出"}
          </button>
        </div>
      </form>

      {/* 按钮禁用要说明原因，否则用户只能猜为什么点不动。 */}
      {!rangeValid && <p className="rc-live" aria-live="polite">
        {days === null ? "请选择有效的日期区间，结束日期不能早于开始日期。" : `区间为 ${days} 天，超过 ${MAX_DAYS} 天上限。`}
      </p>}
      {rangeValid && !reasonValid && <p className="rc-live" aria-live="polite">
        审计原因还需要 {Math.max(REASON_MIN - reasonLength, 0)} 个字符。
      </p>}
      {busy && <p className="rc-live" aria-live="polite">正在读取脱敏投影…</p>}
      {error && <p className="rc-live" role="alert">{error}</p>}
    </section>

    {result && <section className="rc-panel" aria-labelledby="work-record-export-result-title">
      <header>
        <div>
          <small>{result.from} — {result.to} · UTC</small>
          <h2 id="work-record-export-result-title">导出结果</h2>
        </div>
        <StatusBadge value={result.truncated ? `已截断至 ${result.maxRows} 条` : `${result.rowCount} 条`} />
      </header>

      {result.truncated && <p className="rc-live" role="alert">
        本次结果命中 {result.maxRows} 条上限，**不是该区间的完整记录**。请缩小日期范围后分批导出。
      </p>}

      <p className="rc-muted">
        结果只存在于本次响应中，服务端不落导出文件。真实订单路由保持关闭
        （realOrderRoutingEnabled = {String(result.realOrderRoutingEnabled)}），
        记录中的意图与成交均为 Paper 模拟。
      </p>

      {result.rows.length === 0
        ? <p className="rc-muted">该区间内没有工作记录。</p>
        /* jsx-a11y 不允许非交互元素带 tabIndex，而 axe 的 scrollable-region-focusable
           要求可滚动区域必须能被键盘聚焦。两条规则在这里冲突，以实际行为为准。 */
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        : <div className="rc-table-scroll" tabIndex={0} role="region" aria-labelledby="work-record-export-result-title">
          <table className="rc-table">
            <thead><tr>
              <th>发生时间（UTC）</th><th>客户伪名</th><th>策略</th><th>品种/周期</th>
              <th>决策</th><th>准入</th><th>意图</th><th>成交</th>
            </tr></thead>
            <tbody>
              {/* 页面只预览前 50 条：这是个受控导出界面，不是数据浏览器；
                  完整结果在响应体里，避免一次渲染上千行拖垮页面。 */}
              {result.rows.slice(0, 50).map((row) => <tr key={row.recordId}>
                <td>{row.occurredAt}</td>
                <td className="rc-mono">{row.customerPseudonym.slice(0, 12)}…</td>
                <td>{row.strategyCode}</td>
                <td>{row.symbol} · {row.timeframe}</td>
                <td>{row.decisionStatus}</td>
                <td>{row.admissionStatus}</td>
                <td>{row.orderIntentCount}</td>
                <td>{row.fillReceiptCount}</td>
              </tr>)}
            </tbody>
          </table>
        </div>}

      {result.rows.length > 50 && <p className="rc-muted">
        页面只预览前 50 条，本次共 {result.rowCount} 条。
      </p>}
    </section>}
  </>;
}

export default WorkRecordExportWorkspace;
