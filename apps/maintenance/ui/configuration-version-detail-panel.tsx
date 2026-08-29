"use client";

import { useEffect, useState } from "react";

import type { ConfigurationActivationAction, ConfigurationApprovalDecision, ConfigurationTestResult } from "@/lib/versioned-configuration-domain";
import type { ConfigurationVersion } from "@/packages/contracts/src/versioned-configuration";
import { formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { StatusBadge } from "@/packages/ui/src/page-state";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { changedTopLevelKeys, defaultScheduleLocal, localDateTimeWithOffset, offsetForLocalDateTime, shortHash } from "./configuration-version-ui";

export function ConfigurationVersionDetailPanel({ version, current, currentUserId, canManage, canApprove, canActivate, busy, onTest, onRegisteredTest, onReview, onSchedule, onActivation }: {
  version: ConfigurationVersion;
  current: ConfigurationVersion | null;
  currentUserId: string;
  canManage: boolean;
  canApprove: boolean;
  canActivate: boolean;
  busy: boolean;
  onTest: (result: ConfigurationTestResult, evidenceSha256: string, reason: string) => Promise<void>;
  onRegisteredTest: (reason: string) => Promise<void>;
  onReview: (decision: ConfigurationApprovalDecision, reason: string) => Promise<void>;
  onSchedule: (scheduledFor: string, reason: string) => Promise<void>;
  onActivation: (action: ConfigurationActivationAction, reason: string) => Promise<void>;
}) {
  const { locale, t } = useAppLocale();
  const [testResult, setTestResult] = useState<ConfigurationTestResult>("passed");
  const [evidence, setEvidence] = useState("");
  const [testReason, setTestReason] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [scheduleLocal, setScheduleLocal] = useState(defaultScheduleLocal);
  const [scheduleReason, setScheduleReason] = useState("");
  const [activationReason, setActivationReason] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
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
  const registeredFeatureFlag = version.kind === "feature_flag"
    && version.key === "client.strategy_research"
    && version.audience === "client"
    && [1, 2].includes(version.schemaVersion);

  return <section className="rc-panel">
    <header><div><small>SELECTED CONFIGURATION</small><h2>{version.key} · v{version.versionNumber}</h2></div><StatusBadge value={version.status} /></header>
    <dl className="rc-description-list">
      <div><dt>{t("配置流")}</dt><dd>{version.kind} / {version.audience}</dd></div>
      <div><dt>Payload SHA-256</dt><dd title={version.payloadSha256}>{shortHash(version.payloadSha256, 16)}</dd></div>
      <div><dt>{t("创建者")}</dt><dd><small>{version.createdByUserId}</small></dd></div>
      <div><dt>{t("与当前版本差异")}</dt><dd>{current ? changed.length ? changed.join(locale === "zh-CN" ? "、" : ", ") : t("顶层字段无差异") : t("当前流尚无 active 版本")}</dd></div>
      <div><dt>{t("最新测试")}</dt><dd>{version.latestTest ? `${version.latestTest.result} · ${formatDateTime(version.latestTest.createdAt, locale)}` : t("未登记")}</dd></div>
      <div><dt>{t("独立审批")}</dt><dd>{version.approval ? `${version.approval.decision} · ${formatDateTime(version.approval.createdAt, locale)}` : t("待审批")}</dd></div>
      <div><dt>{t("计划时间")}</dt><dd>{version.schedule ? formatDateTime(version.schedule.scheduledFor, locale) : t("未调度")}</dd></div>
      <div><dt>{t("控制面 current")}</dt><dd>{version.isCurrent ? t("是") : t("否")}</dd></div>
    </dl>
    <details><summary>{t("查看不可变 payload")}</summary><pre className="rc-config-payload"><code>{JSON.stringify(version.payload, null, 2)}</code></pre></details>

    {canManage && !version.approval ? registeredFeatureFlag
      ? <div className="rc-form rc-form-grid rc-config-action-block">
        <InlineAuditReasonField id={`configuration-test-reason-${version.id}`} value={testReason} onChange={setTestReason} label={t("确定性测试原因")} hint={t("结果与证据 SHA-256 均由服务端根据不可变 payload 生成，浏览器不能指定。")} />
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !hasValidAuditReason(testReason)} onClick={() => void onRegisteredTest(testReason).then(() => setTestReason("")).catch(() => undefined)}>{busy ? t("正在测试…") : t("运行确定性测试")}</button></div>
      </div>
      : <div className="rc-form rc-form-grid rc-config-action-block">
        <label>{t("测试结果")}<select value={testResult} onChange={(event) => setTestResult(event.target.value as ConfigurationTestResult)}><option value="passed">passed</option><option value="failed">failed</option></select></label>
        <label>{t("测试证据 SHA-256")}<input spellCheck={false} maxLength={64} value={evidence} onChange={(event) => setEvidence(event.target.value.toLowerCase())} /></label>
        <InlineAuditReasonField id={`configuration-test-reason-${version.id}`} value={testReason} onChange={setTestReason} label={t("测试登记原因")} hint={t("这里只登记外部测试产生的证据，不会从浏览器执行自动测试。")} />
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || evidence.length !== 64 || !hasValidAuditReason(testReason)} onClick={() => void onTest(testResult, evidence, testReason).then(() => setTestReason("")).catch(() => undefined)}>{busy ? t("正在登记…") : t("登记测试证据")}</button></div>
      </div> : null}

    {!version.approval && testPassed && canApprove ? <div className="rc-form rc-form-grid rc-config-action-block">
      {!independentlyReviewable ? <p className="rc-muted rc-wide-field">{t("创建者不能审批自己的配置版本，请由另一名具备审批权限的人员处理。")}</p> : <>
        <InlineAuditReasonField id={`configuration-review-reason-${version.id}`} value={reviewReason} onChange={setReviewReason} label={t("审批原因")} hint={t("决定会直接写入不可变审批事实；拒绝后必须创建新版本。")} />
        <div className="rc-action-row rc-wide-field"><button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(reviewReason)} onClick={() => void onReview("reject", reviewReason).then(() => setReviewReason("")).catch(() => undefined)}>{t("拒绝版本")}</button><button className="rc-primary" type="button" disabled={busy || !hasValidAuditReason(reviewReason)} onClick={() => void onReview("approve", reviewReason).then(() => setReviewReason("")).catch(() => undefined)}>{t("批准版本")}</button></div>
      </>}
    </div> : null}

    {version.approval?.decision === "approve" && !version.schedule && canApprove ? <div className="rc-form rc-form-grid rc-config-action-block">
      <label>{t("本地计划时间")}<input type="datetime-local" value={scheduleLocal} onChange={(event) => setScheduleLocal(event.target.value)} /><small>{Intl.DateTimeFormat().resolvedOptions().timeZone} · {t("明确 offset：")}{scheduledFor || t("待输入")}</small></label>
      <div><small>{t("UTC 预览")}</small><p>{scheduleUtc || t("请输入有效时间")}</p></div>
      <InlineAuditReasonField id={`configuration-schedule-reason-${version.id}`} value={scheduleReason} onChange={setScheduleReason} label={t("调度原因")} hint={t("计划时间和原因会直接写入不可变调度事实。")} />
      <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !scheduledFor || new Date(scheduledFor).getTime() < referenceNow || !hasValidAuditReason(scheduleReason)} onClick={() => void onSchedule(scheduledFor, scheduleReason).then(() => setScheduleReason("")).catch(() => undefined)}>{t("安排生效")}</button></div>
    </div> : null}

    {canActivate && version.schedule && !version.isCurrent ? <div className="rc-form rc-form-grid rc-config-action-block">
      <InlineAuditReasonField id={`configuration-activation-reason-${version.id}`} value={activationReason} onChange={setActivationReason} label={t("激活原因")} hint={registeredFeatureFlag ? t("到达计划时间后会改变 current；策略研究入口从下一次请求开始按环境 Gate 与该版本的全局或定向规则共同判定。") : t("到达计划时间后会直接改变控制面 current；尚未接入运行时的配置族不会改变具体行为。") } />
      <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !due || !hasValidAuditReason(activationReason)} onClick={() => void onActivation("activate", activationReason).then(() => setActivationReason("")).catch(() => undefined)}>{due ? t("立即激活") : t("尚未到计划时间")}</button></div>
    </div> : null}
    {canActivate && version.status === "superseded" ? <div className="rc-form rc-form-grid rc-config-action-block">
      <InlineAuditReasonField id={`configuration-rollback-reason-${version.id}`} value={rollbackReason} onChange={setRollbackReason} label={t("回滚原因")} hint={t("提交后会直接把控制面 current 回滚到此历史版本，并保留完整事实链。")} />
      <div className="rc-action-row rc-wide-field"><button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(rollbackReason)} onClick={() => void onActivation("rollback", rollbackReason).then(() => setRollbackReason("")).catch(() => undefined)}>{t("回滚到此版本")}</button></div>
    </div> : null}
  </section>;
}
