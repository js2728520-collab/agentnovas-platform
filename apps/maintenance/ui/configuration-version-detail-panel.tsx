"use client";

import { useEffect, useState } from "react";

import type { ConfigurationActivationAction, ConfigurationApprovalDecision, ConfigurationTestResult } from "@/lib/versioned-configuration-domain";
import type { ConfigurationVersion } from "@/packages/contracts/src/versioned-configuration";
import { formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { StatusBadge } from "@/packages/ui/src/page-state";
import { changedTopLevelKeys, defaultScheduleLocal, localDateTimeWithOffset, offsetForLocalDateTime, shortHash } from "./configuration-version-ui";

export function ConfigurationVersionDetailPanel({ version, current, currentUserId, canManage, canApprove, canActivate, busy, onTest, onReview, onSchedule, onActivation }: {
  version: ConfigurationVersion;
  current: ConfigurationVersion | null;
  currentUserId: string;
  canManage: boolean;
  canApprove: boolean;
  canActivate: boolean;
  busy: boolean;
  onTest: (result: ConfigurationTestResult, evidenceSha256: string, reason: string) => Promise<void>;
  onReview: (decision: ConfigurationApprovalDecision) => void;
  onSchedule: (scheduledFor: string) => void;
  onActivation: (action: ConfigurationActivationAction) => void;
}) {
  const [testResult, setTestResult] = useState<ConfigurationTestResult>("passed");
  const [evidence, setEvidence] = useState("");
  const [testReason, setTestReason] = useState("");
  const [scheduleLocal, setScheduleLocal] = useState(defaultScheduleLocal);
  const [referenceNow, setReferenceNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setReferenceNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const changed = changedTopLevelKeys(current?.payload ?? null, version.payload);
  const scheduledFor = localDateTimeWithOffset(scheduleLocal, offsetForLocalDateTime(scheduleLocal));
  const scheduleUtc = scheduledFor ? new Date(scheduledFor).toISOString() : "";
  const independentlyReviewable = version.createdByUserId !== currentUserId;
  const testPassed = version.latestTest?.result === "passed";
  const due = version.schedule ? new Date(version.schedule.scheduledFor).getTime() <= referenceNow : false;

  return <section className="rc-panel">
    <header><div><small>SELECTED CONFIGURATION</small><h2>{version.key} · v{version.versionNumber}</h2></div><StatusBadge value={version.status} /></header>
    <dl className="rc-description-list">
      <div><dt>配置流</dt><dd>{version.kind} / {version.audience}</dd></div>
      <div><dt>Payload SHA-256</dt><dd title={version.payloadSha256}>{shortHash(version.payloadSha256, 16)}</dd></div>
      <div><dt>创建者</dt><dd><small>{version.createdByUserId}</small></dd></div>
      <div><dt>与当前版本差异</dt><dd>{current ? changed.length ? changed.join("、") : "顶层字段无差异" : "当前流尚无 active 版本"}</dd></div>
      <div><dt>最新测试</dt><dd>{version.latestTest ? `${version.latestTest.result} · ${formatDateTime(version.latestTest.createdAt)}` : "未登记"}</dd></div>
      <div><dt>独立审批</dt><dd>{version.approval ? `${version.approval.decision} · ${formatDateTime(version.approval.createdAt)}` : "待审批"}</dd></div>
      <div><dt>计划时间</dt><dd>{version.schedule ? formatDateTime(version.schedule.scheduledFor) : "未调度"}</dd></div>
      <div><dt>控制面 current</dt><dd>{version.isCurrent ? "是" : "否"}</dd></div>
    </dl>
    <details><summary>查看不可变 payload</summary><pre className="rc-config-payload"><code>{JSON.stringify(version.payload, null, 2)}</code></pre></details>

    {canManage && !version.approval ? <div className="rc-form rc-form-grid rc-config-action-block">
      <label>测试结果<select value={testResult} onChange={(event) => setTestResult(event.target.value as ConfigurationTestResult)}><option value="passed">passed</option><option value="failed">failed</option></select></label>
      <label>测试证据 SHA-256<input spellCheck={false} maxLength={64} value={evidence} onChange={(event) => setEvidence(event.target.value.toLowerCase())} /></label>
      <InlineAuditReasonField id={`configuration-test-reason-${version.id}`} value={testReason} onChange={setTestReason} label="测试登记原因" hint="这里只登记外部测试产生的证据，不会从浏览器执行自动测试。" />
      <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || evidence.length !== 64 || !hasValidAuditReason(testReason)} onClick={() => void onTest(testResult, evidence, testReason).then(() => setTestReason("")).catch(() => undefined)}>{busy ? "正在登记…" : "登记测试证据"}</button></div>
    </div> : null}

    {!version.approval && testPassed && canApprove ? <div className="rc-config-action-block">
      {!independentlyReviewable ? <p className="rc-muted">创建者不能审批自己的配置版本，请由另一名具备审批权限的人员处理。</p> : <div className="rc-action-row"><button className="rc-button" type="button" disabled={busy} onClick={() => onReview("reject")}>拒绝版本</button><button className="rc-primary" type="button" disabled={busy} onClick={() => onReview("approve")}>批准版本</button></div>}
    </div> : null}

    {version.approval?.decision === "approve" && !version.schedule && canApprove ? <div className="rc-form rc-form-grid rc-config-action-block">
      <label>本地计划时间<input type="datetime-local" value={scheduleLocal} onChange={(event) => setScheduleLocal(event.target.value)} /><small>{Intl.DateTimeFormat().resolvedOptions().timeZone} · 明确 offset：{scheduledFor || "待输入"}</small></label>
      <div><small>UTC 预览</small><p>{scheduleUtc || "请输入有效时间"}</p></div>
      <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !scheduledFor || new Date(scheduledFor).getTime() < referenceNow} onClick={() => onSchedule(scheduledFor)}>核对并安排生效</button></div>
    </div> : null}

    {canActivate && version.schedule && !version.isCurrent ? <div className="rc-config-action-block"><div className="rc-action-row"><button className="rc-primary" type="button" disabled={busy || !due} onClick={() => onActivation("activate")}>{due ? "确认立即激活" : "尚未到计划时间"}</button></div></div> : null}
    {canActivate && version.status === "superseded" ? <div className="rc-config-action-block"><div className="rc-action-row"><button className="rc-button" type="button" disabled={busy} onClick={() => onActivation("rollback")}>回滚到此版本</button></div></div> : null}
  </section>;
}
