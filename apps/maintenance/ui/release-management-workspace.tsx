"use client";

import { useRef, useState } from "react";

import type {
  ReleaseDecision,
  ReleaseDeploymentAction,
  ReleaseDeploymentStatus,
  ReleaseEnvironment,
} from "@/lib/release-version-domain";
import type { ReleaseManagementPayload, ReleaseVersion } from "@/packages/contracts/src/release-management";
import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { AccessDenied, EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type Registration = {
  versionTag: string;
  channel: "beta" | "stable";
  commitSha: string;
  artifactSha256: string;
  migrationVersion: string;
  releaseNotes: string;
};

type ReleaseAction =
  | { kind: "register" }
  | { kind: "verify"; release: ReleaseVersion; decision: ReleaseDecision }
  | { kind: "deployment"; release: ReleaseVersion };

function commandKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function shortHash(value: string | null | undefined, missing: string, size = 12) {
  return value ? `${value.slice(0, size)}…` : missing;
}

export function ReleaseManagementWorkspace({ currentUserId, canManage, canApprove, canViewEvidence }: {
  currentUserId: string;
  canManage: boolean;
  canApprove: boolean;
  canViewEvidence: boolean;
}) {
  if (!canViewEvidence) return <AccessDenied />;
  return <ReleaseEvidenceWorkspace currentUserId={currentUserId} canManage={canManage} canApprove={canApprove} />;
}

function ReleaseEvidenceWorkspace({ currentUserId, canManage, canApprove }: {
  currentUserId: string;
  canManage: boolean;
  canApprove: boolean;
}) {
  const { t } = useAppLocale();
  const resource = useApiData<ReleaseManagementPayload>("/api/maintenance/releases?limit=50", t("发布版本读取失败"));
  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取版本与部署证据…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message={t("版本管理控制面不可用")} retry={resource.refresh} />;
  return <ReleaseManagementControl
    initial={resource.data}
    currentUserId={currentUserId}
    canManage={canManage}
    canApprove={canApprove}
    refresh={resource.refresh}
  />;
}

function ReleaseManagementControl({ initial, currentUserId, canManage, canApprove, refresh }: {
  initial: ReleaseManagementPayload;
  currentUserId: string;
  canManage: boolean;
  canApprove: boolean;
  refresh: () => Promise<void>;
}) {
  const { locale, t } = useAppLocale();
  const [registration, setRegistration] = useState<Registration>({
    versionTag: initial.runtime.versionTag ?? "v1.0.0-beta.1",
    channel: "beta",
    commitSha: initial.runtime.commitSha ?? "",
    artifactSha256: initial.runtime.artifactSha256 ?? "",
    migrationVersion: "0041_release_version_management",
    releaseNotes: "",
  });
  const [selectedId, setSelectedId] = useState(initial.releases[0]?.id ?? "");
  const selected = initial.releases.find((release) => release.id === selectedId) ?? initial.releases[0] ?? null;
  const [verificationEvidence, setVerificationEvidence] = useState("");
  const [ciRunUrl, setCiRunUrl] = useState("");
  const [environment, setEnvironment] = useState<ReleaseEnvironment>("staging");
  const [deploymentAction, setDeploymentAction] = useState<ReleaseDeploymentAction>("deploy");
  const [deploymentStatus, setDeploymentStatus] = useState<ReleaseDeploymentStatus>("succeeded");
  const [deploymentEvidence, setDeploymentEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const registerKey = useRef(commandKey("release-register"));
  const actionKeys = useRef(new Map<string, string>());

  async function mutation(path: string, body: Record<string, unknown>, keyName: string) {
    const key = actionKeys.current.get(keyName) ?? commandKey(keyName);
    actionKeys.current.set(keyName, key);
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fallback = t("版本管理操作失败");
      const detail = apiErrorMessage(payload, fallback);
      throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
    }
    actionKeys.current.delete(keyName);
    return payload;
  }

  async function execute(actionToRun: ReleaseAction) {
    setBusy(true);
    setMessage("");
    try {
      if (actionToRun.kind === "register") {
        const response = await fetch("/api/maintenance/releases", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": registerKey.current },
          body: JSON.stringify(registration),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const fallback = t("版本登记失败");
          const detail = apiErrorMessage(payload, fallback);
          throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
        }
        registerKey.current = commandKey("release-register");
        setMessage(t("版本身份已登记为 draft；必须由另一名有审批权限的运维人员复核。"));
      } else if (actionToRun.kind === "verify") {
        await mutation(`/api/maintenance/releases/${encodeURIComponent(actionToRun.release.id)}/verification`, {
          decision: actionToRun.decision,
          evidenceSha256: verificationEvidence,
          ciRunUrl: ciRunUrl || undefined,
        }, `release-verify:${actionToRun.release.id}:${actionToRun.decision}`);
        setMessage(actionToRun.decision === "approve" ? t("版本验证证据已批准；这不代表任何环境已完成部署。") : t("版本已拒绝，不能登记成功部署。"));
      } else {
        await mutation(`/api/maintenance/releases/${encodeURIComponent(actionToRun.release.id)}/deployments`, {
          environment,
          action: deploymentAction,
          status: deploymentStatus,
          evidenceSha256: deploymentEvidence,
        }, `release-deployment:${actionToRun.release.id}:${environment}:${deploymentAction}:${deploymentStatus}`);
        setMessage(`${t("已登记")} ${environment} ${deploymentAction} ${deploymentStatus} ${t("证据；平台未从浏览器执行服务器切换或迁移。")}`);
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("版本管理操作失败"));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading eyebrow="RELEASE EVIDENCE CONTROL" title={t("版本发布")} description={t("平台控制面只登记证据，不从浏览器执行部署、迁移、切流或回滚命令。")} actions={<StatusBadge value={initial.currentByEnvironment.production ? t("production 已登记") : t("production 未登记")} />} />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-kpi-grid" aria-label={t("当前版本状态")}>
      <article><small>Runtime tag</small><strong className="rc-kpi-status">{initial.runtime.versionTag ?? t("未注入")}</strong><span>{t("进程元数据，不等于部署事实")}</span></article>
      <article><small>Runtime commit</small><strong className="rc-kpi-status" title={initial.runtime.commitSha ?? undefined}>{shortHash(initial.runtime.commitSha, t("未提供"))}</strong><span>{t("只显示安全发布身份")}</span></article>
      <article><small>Staging current</small><strong className="rc-kpi-status">{initial.currentByEnvironment.staging?.versionTag ?? t("未登记")}</strong><span>{shortHash(initial.currentByEnvironment.staging?.commitSha, t("未提供"))}</span></article>
      <article><small>Production current</small><strong className="rc-kpi-status">{initial.currentByEnvironment.production?.versionTag ?? t("未登记")}</strong><span>{shortHash(initial.currentByEnvironment.production?.commitSha, t("未提供"))}</span></article>
    </section>
    {canManage ? <section className="rc-panel">
      <header><div><small>IMMUTABLE RELEASE IDENTITY</small><h2>{t("登记候选版本")}</h2></div><StatusBadge value="maker" /></header>
      <div className="rc-form rc-form-grid">
        <label>{t("版本标签")}<input value={registration.versionTag} onChange={(event) => setRegistration({ ...registration, versionTag: event.target.value })} placeholder="v1.0.0-beta.1" /></label>
        <label>{t("发布通道")}<select value={registration.channel} onChange={(event) => setRegistration({ ...registration, channel: event.target.value as Registration["channel"] })}><option value="beta">beta</option><option value="stable">stable</option></select></label>
        <label>Commit SHA<input spellCheck={false} value={registration.commitSha} onChange={(event) => setRegistration({ ...registration, commitSha: event.target.value })} maxLength={40} /></label>
        <label>Artifact SHA-256<input spellCheck={false} value={registration.artifactSha256} onChange={(event) => setRegistration({ ...registration, artifactSha256: event.target.value })} maxLength={64} /></label>
        <label>Migration version<input spellCheck={false} value={registration.migrationVersion} onChange={(event) => setRegistration({ ...registration, migrationVersion: event.target.value })} /></label>
        <label className="rc-wide-field">{t("发布说明")}<textarea rows={4} maxLength={10000} value={registration.releaseNotes} onChange={(event) => setRegistration({ ...registration, releaseNotes: event.target.value })} placeholder={t("说明用户可见变化、风险边界和已知限制")} /></label>
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy} onClick={() => void execute({ kind: "register" })}>{t("检查并登记")}</button></div>
      </div>
    </section> : null}

    <section className="rc-panel">
      <header><div><small>APPEND-ONLY HISTORY</small><h2>{t("版本与环境证据")}</h2></div><span>{initial.releases.length} {t("个版本")}</span></header>
      {initial.releases.length === 0 ? <EmptyState title={t("尚无发布版本")} description={t("有登记权限的运维人员可先录入 Git、构建产物与迁移身份。")} /> : <div className="rc-card-grid">{initial.releases.map((release) => <article className="rc-card" key={release.id}>
        <header><StatusBadge value={release.status} /><time>{formatDateTime(release.createdAt, locale)}</time></header>
        <h3>{release.versionTag} · {release.channel}</h3>
        <p>{release.releaseNotes}</p>
        <dl><div><dt>Commit</dt><dd title={release.commitSha}>{shortHash(release.commitSha, t("未提供"))}</dd></div><div><dt>Artifact</dt><dd title={release.artifactSha256}>{shortHash(release.artifactSha256, t("未提供"))}</dd></div><div><dt>Migration</dt><dd>{release.migrationVersion}</dd></div><div><dt>{t("当前环境")}</dt><dd>{release.currentEnvironments.join(" / ") || t("无")}</dd></div></dl>
        <footer className="rc-action-row"><button className="rc-button" type="button" aria-pressed={selected?.id === release.id} onClick={() => setSelectedId(release.id)}>{t("查看与登记证据")}</button></footer>
      </article>)}</div>}
    </section>

    {selected ? <section className="rc-panel">
      <header><div><small>SELECTED RELEASE</small><h2>{selected.versionTag} {t("证据控制")}</h2></div><StatusBadge value={selected.status} /></header>
      <dl className="rc-description-list">
        <div><dt>{t("创建者")}</dt><dd><small>{selected.createdByUserId}</small></dd></div>
        <div><dt>{t("复核")}</dt><dd>{selected.verification ? `${selected.verification.decision} · ${formatDateTime(selected.verification.createdAt, locale)}` : t("待独立复核")}</dd></div>
        <div><dt>{t("部署记录")}</dt><dd>{selected.deployments.length}</dd></div>
        <div><dt>{t("审计")}</dt><dd>{t("服务端自动留痕")}</dd></div>
      </dl>
      {selected.verification ? <p>{t("验证证据：")}<code title={selected.verification.evidenceSha256}>{shortHash(selected.verification.evidenceSha256, t("未提供"), 16)}</code>{selected.verification.ciRunUrl ? <> · <a href={selected.verification.ciRunUrl} target="_blank" rel="noreferrer">{t("查看 GitHub Actions run")}</a></> : null}</p> : null}
      {!selected.verification && selected.createdByUserId === currentUserId ? <p className="rc-muted">{t("提交人不能复核自己的版本；请由另一名具备 `maint.releases.approve` 的人员处理。")}</p> : null}
      {!selected.verification && canApprove && selected.createdByUserId !== currentUserId ? <div className="rc-form rc-form-grid">
        <label>{t("验证证据 SHA-256")}<input spellCheck={false} value={verificationEvidence} onChange={(event) => setVerificationEvidence(event.target.value)} maxLength={64} /></label>
        <label>{t("GitHub Actions run URL（可选）")}<input type="url" value={ciRunUrl} onChange={(event) => setCiRunUrl(event.target.value)} placeholder="https://github.com/org/repo/actions/runs/123" /></label>
        <div className="rc-action-row rc-wide-field"><button className="rc-button" type="button" disabled={busy || verificationEvidence.length !== 64} onClick={() => void execute({ kind: "verify", release: selected, decision: "reject" })}>{t("拒绝版本")}</button><button className="rc-primary" type="button" disabled={busy || verificationEvidence.length !== 64} onClick={() => void execute({ kind: "verify", release: selected, decision: "approve" })}>{t("批准验证")}</button></div>
      </div> : null}
      {canApprove && selected.verification?.decision === "approve" ? <div className="rc-form rc-form-grid">
        <label>{t("环境")}<select value={environment} onChange={(event) => setEnvironment(event.target.value as ReleaseEnvironment)}><option value="staging">staging</option><option value="production">production</option></select></label>
        <label>{t("操作")}<select value={deploymentAction} onChange={(event) => setDeploymentAction(event.target.value as ReleaseDeploymentAction)}><option value="deploy">deploy</option><option value="rollback">rollback</option></select></label>
        <label>{t("结果")}<select value={deploymentStatus} onChange={(event) => setDeploymentStatus(event.target.value as ReleaseDeploymentStatus)}><option value="succeeded">succeeded</option><option value="failed">failed</option></select></label>
        <label>{t("部署证据 SHA-256")}<input spellCheck={false} value={deploymentEvidence} onChange={(event) => setDeploymentEvidence(event.target.value)} maxLength={64} /></label>
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || deploymentEvidence.length !== 64} onClick={() => void execute({ kind: "deployment", release: selected })}>{t("登记已执行结果")}</button></div>
      </div> : null}
      {selected.deployments.length ? <div className="rc-table-wrap"><table><thead><tr><th>{t("时间")}</th><th>{t("环境")}</th><th>{t("操作")}</th><th>{t("结果")}</th><th>{t("证据")}</th><th>{t("操作者")}</th></tr></thead><tbody>{selected.deployments.map((deployment) => <tr key={deployment.id}><td>{formatDateTime(deployment.createdAt, locale)}</td><td>{deployment.environment}</td><td>{deployment.action}</td><td><StatusBadge value={deployment.status} /></td><td><small title={deployment.evidenceSha256}>{shortHash(deployment.evidenceSha256, t("未提供"))}</small></td><td><small>{deployment.actorUserId}</small></td></tr>)}</tbody></table></div> : null}
    </section> : null}
  </>;
}
