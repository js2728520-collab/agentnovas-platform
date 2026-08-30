"use client";

import { useRef, useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type EnvironmentState = { environment: "staging" | "production"; generation: number; stop_requested: boolean; blocked: boolean };
type CommandMaterial = { imageDigests: Record<"client" | "operations" | "maintenance" | "runtime", string>; migrationSetSha256: string; hasIrreversibleMigrations: boolean; materialSha256: string; provenanceEvidenceSha256: string };
type CommandRequest = { id: string; releaseVersionId: string; environment: "staging" | "production"; action: string; activationId: string; material: CommandMaterial; reason: string; requestedByUserId: string; createdAt: string; decision: string | null; reviewerUserId: string | null };
type ActivationRequest = { id: string; releaseVersionId: string; controlBundleId: string; controlBinding: Record<string, string>; environment: "staging" | "production"; artifactManifestSha256: string; requestedByUserId: string; reason: string; expiresAt: string; createdAt: string; securityDecision: string | null; securityReviewerUserId: string | null; releaseDecision: string | null; releaseReviewerUserId: string | null; active: boolean };
type StopRelease = { id: string; environment: "staging" | "production"; activationId: string; reason: string; requestedByUserId: string; createdAt: string; reviewerUserId: string | null; reviewedAt: string | null };
type WorkflowPayload = { environments: EnvironmentState[]; commands: Array<{ command_id: string; status: string; environment: string; action: string; created_at: string }>; commandRequests: CommandRequest[]; activationRequests: ActivationRequest[]; stopReleases: StopRelease[]; stops: Array<{ id: string; environment: string; action: string; generation: number; reason: string; createdAt: string }> };

type WorkflowPermissions = Record<string, string | undefined>;
type Action = { path: string; body: Record<string, unknown>; key?: string; success: string };
type WebAuthnChallenge = { challengeId: string; challenge: string; rpId: string; credentialIds: string[]; timeout: number; userVerification: "required" };

function actionKey(prefix: string) { return `${prefix}:${crypto.randomUUID()}`; }
function isTerminalActionRejection(status: number) {
  return status >= 400 && status < 500 && !new Set([408, 425, 428, 429]).has(status);
}
function short(value: string | null | undefined) { return value ? `${value.slice(0, 12)}…` : "—"; }
function futureIso(minutes: number) { return new Date(Date.now() + minutes * 60_000).toISOString(); }
function decodeBase64url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function encodeBase64url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function signExactReleaseAction(challenge: WebAuthnChallenge) {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("当前浏览器不支持 WebAuthn 发布动作确认");
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: decodeBase64url(challenge.challenge), rpId: challenge.rpId,
    allowCredentials: challenge.credentialIds.map((id) => ({ type: "public-key", id: decodeBase64url(id) })),
    timeout: challenge.timeout, userVerification: challenge.userVerification,
  } });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("未取得有效的人类发布动作签名");
  }
  return {
    "x-release-webauthn-challenge-id": challenge.challengeId,
    "x-release-webauthn-credential-id": credential.id,
    "x-release-webauthn-client-data": encodeBase64url(credential.response.clientDataJSON),
    "x-release-webauthn-authenticator-data": encodeBase64url(credential.response.authenticatorData),
    "x-release-webauthn-signature": encodeBase64url(credential.response.signature),
    ...(credential.response.userHandle ? { "x-release-webauthn-user-handle": encodeBase64url(credential.response.userHandle) } : {}),
  };
}

export function RestrictedCicdWorkspace({ currentUserId, permissions }: { currentUserId: string; permissions: WorkflowPermissions }) {
  const resource = useApiData<WorkflowPayload>("/api/maintenance/release-workflow?limit=50", "受限发布工作流读取失败");
  const [environment, setEnvironment] = useState<"staging" | "production">("staging");
  const [releaseVersionId, setReleaseVersionId] = useState("");
  const [activationId, setActivationId] = useState("");
  const [action, setAction] = useState<"deploy" | "rollback">("deploy");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const idempotency = useRef(new Map<string, { key: string; requestId: string; body: Record<string, unknown> }>());

  const allowed = (permission: string) => Boolean(permissions[permission]);

  async function execute(input: Action) {
    setBusy(true); setMessage("");
    try {
      const pending = input.key ? (idempotency.current.get(input.key) ?? {
        key: actionKey(input.key), requestId: crypto.randomUUID(), body: structuredClone(input.body),
      }) : null;
      if (input.key && pending) idempotency.current.set(input.key, pending);
      const requestBody = JSON.stringify(pending?.body ?? input.body);
      const requestHeaders = { "content-type": "application/json", ...(pending ? {
        "idempotency-key": pending.key, "x-request-id": pending.requestId,
      } : {}) };
      const send = (assertionHeaders: Record<string, string> = {}) => fetch(input.path, {
        method: "POST", headers: { ...requestHeaders, ...assertionHeaders }, body: requestBody,
      });
      let response = await send();
      let payload = await response.json().catch(() => ({})) as { error?: { code?: string; details?: { webAuthn?: WebAuthnChallenge } } };
      if (response.status === 428 && payload.error?.code === "WEBAUTHN_ACTION_REQUIRED" && payload.error.details?.webAuthn) {
        response = await send(await signExactReleaseAction(payload.error.details.webAuthn));
        payload = await response.json().catch(() => ({}));
      }
      if (!response.ok) {
        if (input.key && isTerminalActionRejection(response.status)) idempotency.current.delete(input.key);
        throw new Error(apiErrorMessage(payload, "受限发布工作流操作失败"));
      }
      if (input.key) idempotency.current.delete(input.key);
      setMessage(input.success);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "受限发布工作流操作失败"); }
    finally { setBusy(false); }
  }

  if (resource.loading && !resource.data) return <LoadingState label="正在读取受限发布工作流…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message="受限发布控制面不可用" retry={resource.refresh} />;
  const data = resource.data;
  const environmentState = (name: "staging" | "production") => data.environments.find((item) => item.environment === name);
  const canRequestCommand = environment === "staging" ? allowed("maint.releases.workflow.stage") : allowed("maint.releases.workflow.production.request");

  return <section className="rc-panel" aria-labelledby="restricted-cicd-title">
    <header><div><small>DEFAULT-OFF RELEASE ORCHESTRATOR</small><h2 id="restricted-cicd-title">受限 CI/CD 控制</h2><p>这里只追加请求与审批事实。Worker、Ingress、目标网关和专用 workflow 未通过 G7 前仍保持关闭；页面不会执行 SSH、Shell、SQL 或任意 workflow。</p></div><StatusBadge value="disabled" /></header>
    <div className="rc-live" aria-live="polite">{message}</div>
    <div className="rc-kpi-grid" aria-label="受限发布环境状态">
      {(["staging", "production"] as const).map((name) => { const state = environmentState(name); return <article key={name}><small>{name}</small><strong className="rc-kpi-status">generation {state?.generation ?? "—"}</strong><span>{state?.stop_requested ? "sticky stop requested" : state?.blocked ? "blocked" : "未停止；执行器仍关闭"}</span></article>; })}
      <article><small>待审命令</small><strong className="rc-kpi-status">{data.commandRequests.filter((item) => !item.decision).length}</strong><span>不可变 maker/checker 事实</span></article>
      <article><small>有效 activation</small><strong className="rc-kpi-status">{data.activationRequests.filter((item) => item.active && new Date(item.expiresAt) > new Date()).length}</strong><span>按环境与摘要绑定</span></article>
    </div>

    <div className="rc-form rc-form-grid">
      <label>目标环境<select value={environment} onChange={(event) => setEnvironment(event.target.value as typeof environment)}><option value="staging">staging</option><option value="production">production</option></select></label>
      <label>操作<select value={action} onChange={(event) => setAction(event.target.value as typeof action)}><option value="deploy">deploy</option><option value="rollback">rollback</option></select></label>
    </div>

    {allowed("maint.releases.workflow.activation.request") ? <details className="rc-card"><summary>请求 activation</summary><div className="rc-form">
      <label>Release version ID<input spellCheck={false} value={releaseVersionId} onChange={(event) => setReleaseVersionId(event.target.value)} /></label>
      <p>G7、provider、workflow、target 与 trust 绑定只从服务端不可变 control bundle 推导，浏览器不能提交或覆盖。</p>
      <div className="rc-action-row"><button className="rc-primary" type="button" disabled={busy || !releaseVersionId} onClick={() => void execute({ path: "/api/maintenance/release-workflow/activations", key: `activation:${environment}:${releaseVersionId}`, body: { releaseVersionId, environment, expiresAt: futureIso(120) }, success: "Activation 请求已追加；必须由两名不同 checker 分别完成 security 与 release 审批。" })}>提交 activation 请求</button></div>
    </div></details> : null}

    {canRequestCommand ? <details className="rc-card"><summary>请求 {environment} {action}</summary><div className="rc-form rc-form-grid">
      <label>Release version ID<input spellCheck={false} value={releaseVersionId} onChange={(event) => setReleaseVersionId(event.target.value)} /></label>
      <p className="rc-wide-field">镜像、迁移集、不可逆标记、activation 与 rollback evidence 全部由数据库从已登记制品及当前环境历史推导。</p>
      <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !releaseVersionId} onClick={() => void execute({ path: `/api/maintenance/release-workflow/commands/${environment}?releaseVersionId=${encodeURIComponent(releaseVersionId)}`, key: `command:${environment}:${action}:${releaseVersionId}`, body: { environment, action }, success: `${environment} ${action} 请求已追加；执行器仍保持关闭，审批也不代表已经部署。` })}>提交命令请求</button></div>
    </div></details> : null}

    {allowed("maint.releases.workflow.stop") ? <div className="rc-action-row"><button className="rc-danger-button" type="button" disabled={busy} onClick={() => void execute({ path: "/api/maintenance/release-workflow/stops", key: `stop:${environment}`, body: { environment }, success: `${environment} sticky stop 已请求；目标确认前状态会保持 stop pending。` })}>请求 {environment} sticky stop</button></div> : null}

    <h3>Activation 请求</h3>
    {data.activationRequests.length === 0 ? <EmptyState title="尚无 activation 请求" description="先提交与 G7、provider、target 和 trust 摘要绑定的请求。" /> : <div className="rc-card-grid">{data.activationRequests.map((item) => <article className="rc-card" key={item.id}><header><StatusBadge value={item.active ? "active" : "pending"} /><time>{formatDateTime(item.createdAt)}</time></header><h3>{item.environment} · {short(item.artifactManifestSha256)}</h3><p>release {item.releaseVersionId} · control bundle {item.controlBundleId}</p><details><summary>服务端 control binding</summary>{Object.entries(item.controlBinding).map(([name, digest]) => <p key={name}>{name} <code>{digest}</code></p>)}</details><p>security: {item.securityDecision ?? "待审"} · release: {item.releaseDecision ?? "待审"}</p>
      {allowed("maint.releases.workflow.activation.approve") && item.requestedByUserId !== currentUserId ? <div className="rc-action-row">{(["security", "release"] as const).map((kind) => <button key={kind} className="rc-button" type="button" disabled={busy || (kind === "security" ? Boolean(item.securityDecision) : Boolean(item.releaseDecision))} onClick={() => void execute({ path: `/api/maintenance/release-workflow/activations/${encodeURIComponent(item.id)}/review`, key: `activation-review:${item.id}:${kind}`, body: { approvalKind: kind, decision: "approve" }, success: `${kind} activation 审批已追加。` })}>批准 {kind}</button>)}</div> : null}
      {item.active && item.environment === "production" && allowed("maint.releases.workflow.production.enable") ? <div className="rc-action-row"><button className="rc-primary" type="button" disabled={busy} onClick={() => void execute({ path: `/api/maintenance/release-workflow/activations/${encodeURIComponent(item.id)}/production-enablement`, key: `production-enable:${item.id}`, body: { expiresAt: futureIso(60) }, success: "首次 production enablement 已创建；仍需 G7 和显式命令审批。" })}>创建首次 production enablement</button></div> : null}
    </article>)}</div>}

    <h3>命令请求</h3>
    {data.commandRequests.length === 0 ? <EmptyState title="尚无命令请求" description="命令只能引用已完成双审且未过期的 activation。" /> : <div className="rc-table-wrap"><table><thead><tr><th>时间</th><th>环境 / 操作</th><th>Release</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.commandRequests.map((item) => {
      const canReview = item.environment === "staging" ? allowed("maint.releases.workflow.stage") : allowed("maint.releases.workflow.production.approve");
      return <tr key={item.id}><td>{formatDateTime(item.createdAt)}</td><td>{item.environment} / {item.action}</td><td><small>{item.releaseVersionId}</small><details><summary>服务端制品事实</summary><p>material <code>{item.material.materialSha256}</code></p><p>provenance <code>{item.material.provenanceEvidenceSha256}</code></p><p>migration <code>{item.material.migrationSetSha256}</code> · irreversible {String(item.material.hasIrreversibleMigrations)}</p>{Object.entries(item.material.imageDigests).map(([name, digest]) => <p key={name}>{name} <code>{digest}</code></p>)}</details></td><td><StatusBadge value={item.decision ?? "pending"} /></td><td>{canReview && !item.decision && item.requestedByUserId !== currentUserId ? <div className="rc-action-row"><button className="rc-button" type="button" disabled={busy} onClick={() => void execute({ path: `/api/maintenance/release-workflow/commands/${item.environment}/${encodeURIComponent(item.id)}/review`, key: `command-review:${item.id}:reject`, body: { decision: "reject", expiresAt: futureIso(30) }, success: "命令请求已拒绝。" })}>拒绝</button><button className="rc-primary" type="button" disabled={busy} onClick={() => void execute({ path: `/api/maintenance/release-workflow/commands/${item.environment}/${encodeURIComponent(item.id)}/review`, key: `command-review:${item.id}:approve`, body: { decision: "approve", expiresAt: futureIso(30) }, success: "命令 snapshot 已冻结并批准；执行器默认关闭，尚未发生部署。" })}>批准</button></div> : "—"}</td></tr>;
    })}</tbody></table></div>}

    {allowed("maint.releases.workflow.stop.release") ? <details className="rc-card"><summary>申请解除 sticky stop</summary><div className="rc-form rc-form-grid"><label>Fresh activation ID<input spellCheck={false} value={activationId} onChange={(event) => setActivationId(event.target.value)} /></label><div className="rc-action-row"><button className="rc-button" type="button" disabled={busy || !activationId} onClick={() => void execute({ path: "/api/maintenance/release-workflow/stops/release", key: `stop-release:${environment}`, body: { environment, activationId }, success: "解除 stop 请求已追加；target clear acknowledgement 与不同 checker 都到位后才能提交。" })}>请求解除 {environment} stop</button></div></div></details> : null}
    {data.stopReleases.filter((item) => !item.reviewerUserId).map((item) => allowed("maint.releases.workflow.stop.release") && item.requestedByUserId !== currentUserId ? <div className="rc-action-row" key={item.id}><span>{item.environment} 解除请求 · {short(item.id)}</span><button className="rc-primary" type="button" disabled={busy} onClick={() => void execute({ path: `/api/maintenance/release-workflow/stops/release/${encodeURIComponent(item.id)}/review`, key: `stop-release-review:${item.id}`, body: {}, success: "解除 stop checker 已追加；若目标前置确认未完成，状态保持停止。" })}>批准解除</button></div> : null)}
  </section>;
}
