"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import type { AppAudience } from "@/lib/riverton-apps";
import type { DataScope } from "@/lib/rbac";
import { apiErrorMessage, formatDateTime, type AccessAssignment, type AccessChangeRequest, type AccessRole, type AccessRoleTemplate, type AuthorizationAuditEvent } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { hasValidAuditReason, InlineAuditReasonField } from "./inline-audit-reason-field";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "./page-state";
import { useApiData } from "./use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type PermissionDefinition = { key: string; appId: AppAudience; label: string; sensitive: boolean };
type DirectAction = { kind: "role" } | { kind: "template" } | { kind: "publish"; role: AccessRole } | { kind: "assignment" };
type PendingAction = { kind: "revoke"; label: string; assignment: AccessAssignment }
  | { kind: "decision"; label: string; request: AccessChangeRequest; decision: "approve" | "reject" };

export function AccessCenter({ appId, permissions, auditOnly = false }: { appId: Exclude<AppAudience, "client">; permissions: Record<string, DataScope>; auditOnly?: boolean }) {
  return auditOnly ? <AccessAudit appId={appId} /> : <AccessManagement appId={appId} permissions={permissions} />;
}

function AccessManagement({ appId, permissions }: { appId: Exclude<AppAudience, "client">; permissions: Record<string, DataScope> }) {
  const { locale, t } = useAppLocale();
  const roles = useApiData<{ roles: AccessRole[] }>("/api/access/roles", t("角色读取失败"));
  const templates = useApiData<{ roleTemplates: AccessRoleTemplate[] }>("/api/access/role-templates", t("角色模板读取失败"));
  const assignments = useApiData<{ assignments: AccessAssignment[] }>("/api/access/assignments", t("角色分配读取失败"));
  const requests = useApiData<{ changeRequests: AccessChangeRequest[] }>("/api/access/change-requests?status=pending&limit=100", t("权限变更读取失败"));
  const catalog = useApiData<{ dataScopes: DataScope[]; permissions: PermissionDefinition[] }>("/api/access/permissions", t("权限目录读取失败"));
  const [tab, setTab] = useState<"roles" | "templates" | "assignments" | "requests">("roles");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<Record<string, DataScope>>({});
  const [templateCode, setTemplateCode] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateSummary, setTemplateSummary] = useState("");
  const [templatePermissions, setTemplatePermissions] = useState<Record<string, DataScope>>({});
  const [targetUserId, setTargetUserId] = useState("");
  const [targetRoleId, setTargetRoleId] = useState("");
  const [roleReason, setRoleReason] = useState("");
  const [templateReason, setTemplateReason] = useState("");
  const [assignmentReason, setAssignmentReason] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selectedRole = roles.data?.roles.find((role) => role.id === targetRoleId);
  const selectedDefinitions = useMemo(() => catalog.data?.permissions.filter((definition) => selectedPermissions[definition.key]) ?? [], [catalog.data, selectedPermissions]);
  const selectedTemplateDefinitions = useMemo(() => catalog.data?.permissions.filter((definition) => templatePermissions[definition.key]) ?? [], [catalog.data, templatePermissions]);
  const canManageRoles = Boolean(permissions[appId === "operations" ? "ops.roles.manage" : "maint.roles.manage"]);
  const canAssignRoles = canManageRoles || Boolean(permissions["ops.roles.assign"]);
  const canReviewRoles = canManageRoles || Boolean(permissions[appId === "operations" ? "ops.roles.approve_sensitive" : "maint.roles.approve_sensitive"]);

  async function refreshAll() {
    await Promise.all([roles.refresh(), templates.refresh(), assignments.refresh(), requests.refresh(), catalog.refresh()]);
  }
  async function jsonRequest(url: string, method: string, body: unknown) {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fallback = t("授权操作失败");
      const detail = apiErrorMessage(payload, fallback);
      throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
    }
    return payload as Record<string, unknown>;
  }
  async function execute(action: DirectAction | PendingAction, reason: string) {
    setBusy(true); setMessage("");
    try {
      if (action.kind === "decision") {
        await jsonRequest(`/api/access/change-requests/${action.request.id}/decisions`, "POST", { decision: action.decision, note: reason });
        setMessage(action.decision === "approve" ? t("权限变更已批准，结果以授权审计为准。") : t("权限变更已拒绝，结果以授权审计为准。"));
      } else if (action.kind === "role") {
        if (!code.trim() || !name.trim() || !selectedDefinitions.length) throw new Error(t("请填写角色代码、名称并选择权限"));
        const permissions = selectedDefinitions.map((definition) => ({ permissionKey: definition.key, scope: selectedPermissions[definition.key] }));
        if (selectedDefinitions.some((definition) => definition.sensitive)) {
          await jsonRequest("/api/access/change-requests", "POST", { applicationId: appId, changeType: "role_create", targetUserId: null, targetRoleId: null, before: {}, after: { code: code.trim(), name: name.trim(), permissions }, reason });
          setMessage(t("敏感角色创建申请已提交，等待第二人审批。"));
        } else {
          const payload = await jsonRequest("/api/access/roles", "POST", { applicationId: appId, code: code.trim(), name: name.trim(), permissions });
          const role = payload.role as { id?: string } | undefined;
          if (!role?.id) throw new Error(t("角色创建回执缺少 ID"));
          await jsonRequest(`/api/access/roles/${role.id}/publish`, "POST", { reason });
          setMessage(t("普通角色已创建并发布。"));
        }
        setCode(""); setName(""); setSelectedPermissions({});
      } else if (action.kind === "template") {
        if (!templateCode.trim() || !templateName.trim() || !selectedTemplateDefinitions.length) throw new Error(t("请填写模板代码、名称并选择权限"));
        const templateRolePermissions = selectedTemplateDefinitions.map((definition) => ({ permissionKey: definition.key, scope: templatePermissions[definition.key] }));
        const changeSummary = templateSummary.trim() || "initial";
        if (selectedTemplateDefinitions.some((definition) => definition.sensitive)) {
          await jsonRequest("/api/access/change-requests", "POST", { applicationId: appId, changeType: "template_publish", targetUserId: null, targetRoleId: null, before: {}, after: { code: templateCode.trim(), name: templateName.trim(), permissions: templateRolePermissions, changeSummary }, reason });
          setMessage(t("敏感角色模板发布申请已提交，等待第二人审批。"));
        } else {
          await jsonRequest("/api/access/role-templates", "POST", { applicationId: appId, code: templateCode.trim(), name: templateName.trim(), permissions: templateRolePermissions, changeSummary });
          setMessage(t("普通角色模板已发布。"));
        }
        setTemplateCode(""); setTemplateName(""); setTemplateSummary(""); setTemplatePermissions({});
      } else if (action.kind === "publish") {
        await jsonRequest(`/api/access/roles/${action.role.id}/publish`, "POST", { reason });
        setMessage(`${t("角色“")}${action.role.name}${t("”已发布并写入授权审计。")}`);
      } else if (action.kind === "assignment") {
        if (!targetUserId.trim() || !selectedRole) throw new Error(t("请选择角色并填写目标用户 ID"));
        const sensitive = selectedRole.permissions.some((permission) => catalog.data?.permissions.some((definition) => definition.key === permission.permissionKey && definition.sensitive));
        if (sensitive) {
          await jsonRequest("/api/access/change-requests", "POST", { applicationId: appId, changeType: "role_assign", targetUserId: targetUserId.trim(), targetRoleId: selectedRole.id, before: {}, after: { expiresAt: null, reason }, reason });
          setMessage(t("敏感角色分配申请已提交，等待第二人审批。"));
        } else {
          await jsonRequest("/api/access/assignments", "POST", { userId: targetUserId.trim(), roleId: selectedRole.id, reason });
          setMessage(t("普通角色已分配。"));
        }
        setTargetUserId(""); setTargetRoleId("");
      } else {
        const assignment = action.assignment;
        await jsonRequest("/api/access/change-requests", "POST", { applicationId: appId, changeType: "role_revoke", targetUserId: assignment.userId, targetRoleId: assignment.roleId, before: {}, after: { assignmentId: assignment.id, reason }, reason });
        setMessage(t("角色撤销申请已提交，等待第二人审批。"));
      }
      if (action.kind === "decision" || action.kind === "revoke") setPending(null);
      await refreshAll();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("授权操作失败")); }
    finally { setBusy(false); }
  }
  const loading = roles.loading || templates.loading || assignments.loading || requests.loading || catalog.loading;
  const error = roles.error || templates.error || assignments.error || requests.error || catalog.error;
  return <>
    <PageHeading eyebrow="ACCESS CONTROL" title={t("角色权限")} description={t("权限目录、角色、分配和敏感变更始终限定在当前应用。")} actions={<button className="rc-button" type="button" onClick={() => void refreshAll()}>{t("刷新")}</button>} />
    <nav className="rc-tabs" aria-label={t("权限中心视图")}><button className={tab === "roles" ? "active" : ""} onClick={() => setTab("roles")}>{t("角色")}</button><button className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}>{t("角色模板")}</button><button className={tab === "assignments" ? "active" : ""} onClick={() => setTab("assignments")}>{t("用户分配")}</button><button className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}>{t("待审批")} ({requests.data?.changeRequests.length ?? 0})</button></nav>
    <div className="rc-live" aria-live="polite">{message}</div>
    {loading && !roles.data ? <LoadingState /> : error && !roles.data ? <ErrorState message={error} retry={() => void refreshAll()} /> : null}
    {tab === "roles" && <div className={canManageRoles ? "rc-split-layout" : ""}>
      {canManageRoles && <section className="rc-panel"><header><div><small>{appId}</small><h2>{t("创建角色")}</h2><p>{t("填写审计原因后直接提交；敏感权限仍会进入双人审批。")}</p></div></header><div className="rc-form"><label>{t("角色代码")}<input value={code} onChange={(event) => setCode(event.target.value)} placeholder={t("例如 deposit_reviewer")} /></label><label>{t("角色名称")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("角色显示名称")} /></label><fieldset className="rc-permission-list"><legend>{t("权限和数据范围")}</legend>{catalog.data?.permissions.map((permission) => <label key={permission.key}><input type="checkbox" checked={Boolean(selectedPermissions[permission.key])} onChange={(event) => setSelectedPermissions((current) => { const next = { ...current }; if (event.target.checked) next[permission.key] = "SELF"; else delete next[permission.key]; return next; })} /><span><b>{t(permission.label)}</b><small>{permission.key}{permission.sensitive ? ` · ${t("敏感")}` : ""}</small></span><select aria-label={`${t(permission.label)} ${t("数据范围")}`} disabled={!selectedPermissions[permission.key]} value={selectedPermissions[permission.key] ?? "SELF"} onChange={(event) => setSelectedPermissions((current) => ({ ...current, [permission.key]: event.target.value as DataScope }))}>{catalog.data?.dataScopes.map((scope) => <option key={scope}>{scope}</option>)}</select></label>)}</fieldset><InlineAuditReasonField id="role-configuration-reason" value={roleReason} onChange={setRoleReason} label={t("角色配置原因")} hint={t("同一原因可连续创建或发布本轮角色，无需重复弹窗。")} /><button className="rc-primary" type="button" disabled={busy || !hasValidAuditReason(roleReason)} onClick={() => void execute({ kind: "role" }, roleReason.trim())}>{t("创建角色")}</button></div></section>}
      <section className="rc-panel"><header><div><small>{roles.data?.roles.length ?? 0} {t("个角色")}</small><h2>{t("当前应用角色")}</h2></div></header>{!roles.data?.roles.length ? <EmptyState title={t("没有角色")} description={t("尚未创建当前应用角色。")} /> : <div className="rc-card-list">{roles.data.roles.map((role) => <article key={role.id}><header><div><b>{role.name}</b><small>{role.code} · {role.kind}</small></div><StatusBadge value={role.status} /></header><p>{role.permissions.map((permission) => `${permission.permissionKey} (${permission.scope})`).join(" · ") || t("未配置权限")}</p>{canManageRoles && role.status === "draft" && <div className="rc-action-row rc-card-actions"><button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(roleReason)} onClick={() => void execute({ kind: "publish", role }, roleReason.trim())}>{t("发布角色")}</button></div>}</article>)}</div>}</section>
    </div>}
    {tab === "templates" && <div className={canManageRoles ? "rc-split-layout" : ""}>
      {canManageRoles && <section className="rc-panel"><header><div><small>{appId}</small><h2>{t("发布角色模板")}</h2><p>{t("填写审计原因后直接提交；敏感模板仍会进入双人审批。")}</p></div></header><div className="rc-form"><label>{t("模板代码")}<input value={templateCode} onChange={(event) => setTemplateCode(event.target.value)} placeholder={t("例如 branch_deposit_team")} /></label><label>{t("模板名称")}<input value={templateName} onChange={(event) => setTemplateName(event.target.value)} /></label><label>{t("版本说明")}<textarea rows={2} value={templateSummary} onChange={(event) => setTemplateSummary(event.target.value)} placeholder={t("说明首版权限用途")} /></label><fieldset className="rc-permission-list"><legend>{t("模板权限和最大数据范围")}</legend>{catalog.data?.permissions.map((permission) => <label key={permission.key}><input type="checkbox" checked={Boolean(templatePermissions[permission.key])} onChange={(event) => setTemplatePermissions((current) => { const next = { ...current }; if (event.target.checked) next[permission.key] = "SELF"; else delete next[permission.key]; return next; })} /><span><b>{t(permission.label)}</b><small>{permission.key}{permission.sensitive ? ` · ${t("敏感")}` : ""}</small></span><select aria-label={`${t(permission.label)} ${t("模板数据范围")}`} disabled={!templatePermissions[permission.key]} value={templatePermissions[permission.key] ?? "SELF"} onChange={(event) => setTemplatePermissions((current) => ({ ...current, [permission.key]: event.target.value as DataScope }))}>{catalog.data?.dataScopes.map((scope) => <option key={scope}>{scope}</option>)}</select></label>)}</fieldset><InlineAuditReasonField id="template-configuration-reason" value={templateReason} onChange={setTemplateReason} label={t("模板配置原因")} hint={t("同一原因可用于本轮模板配置，无需再次确认。")} /><button className="rc-primary" type="button" disabled={busy || !hasValidAuditReason(templateReason)} onClick={() => void execute({ kind: "template" }, templateReason.trim())}>{t("发布模板")}</button></div></section>}
      <section className="rc-panel"><header><div><small>{templates.data?.roleTemplates.length ?? 0} {t("个模板")}</small><h2>{t("当前应用模板")}</h2></div></header>{!templates.data?.roleTemplates.length ? <EmptyState title={t("没有角色模板")} description={t("当前应用尚未发布可复用角色模板。")} /> : <div className="rc-card-list">{templates.data.roleTemplates.map((template) => <article key={template.id}><header><div><b>{template.name}</b><small>{template.code} · {t("版本")} {template.currentVersion ?? "—"}</small></div><StatusBadge value={template.status} /></header><p>{t("模板仅能在当前应用使用；派生角色不能扩大模板权限或数据范围。")}</p></article>)}</div>}</section>
    </div>}
    {tab === "assignments" && <section className="rc-panel"><header><div><small>{t("用户与角色")}</small><h2>{t("角色分配")}</h2><p>{t("普通分配直接生效；敏感角色仍只提交双人审批申请。")}</p></div></header>{canAssignRoles && <div className="rc-form rc-inline-form"><label>{t("目标用户 ID")}<input value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} /></label><label>{t("已发布角色")}<select value={targetRoleId} onChange={(event) => setTargetRoleId(event.target.value)}><option value="">{t("请选择")}</option>{roles.data?.roles.filter((role) => role.status === "published").map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label><InlineAuditReasonField id="role-assignment-reason" value={assignmentReason} onChange={setAssignmentReason} label={t("角色分配原因")} hint={t("原因直接随本次分配或审批申请写入审计记录。")} /><button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(assignmentReason)} onClick={() => void execute({ kind: "assignment" }, assignmentReason.trim())}>{t("分配")}</button></div>}<div className="rc-table-wrap"><table><thead><tr><th>{t("用户")}</th><th>{t("角色")}</th><th>{t("状态")}</th><th>{t("生效时间")}</th><th>{t("操作")}</th></tr></thead><tbody>{assignments.data?.assignments.map((assignment) => <tr key={assignment.id}><td><small>{assignment.userId}</small></td><td>{assignment.roleName}<small>{assignment.roleCode}</small></td><td><StatusBadge value={assignment.status} /></td><td>{formatDateTime(assignment.effectiveAt, locale)}</td><td>{canAssignRoles && assignment.status === "active" && <button className="rc-button rc-danger-button" type="button" onClick={() => setPending({ kind: "revoke", label: `${t("撤销")} ${assignment.roleName}`, assignment })}>{t("申请撤销")}</button>}</td></tr>)}</tbody></table></div></section>}
    {tab === "requests" && <section className="rc-panel"><header><div><small>{t("双人审批")}</small><h2>{t("待处理变更")}</h2></div>{appId === "operations" && canReviewRoles && <Link className="rc-button" href="/governance?tab=approvals">{t("进入综合审批中心")}</Link>}</header>{!requests.data?.changeRequests.length ? <EmptyState title={t("没有待审批变更")} description={t("当前应用的敏感授权队列为空。")} /> : <div className="rc-card-list">{requests.data.changeRequests.map((request) => <article key={request.id}><header><div><b>{request.changeType}</b><small>{request.requestedBy.email || request.requestedBy.userId} · {formatDateTime(request.requestedAt, locale)}</small></div><StatusBadge value={request.canReview ? request.status : t("禁止自审")} /></header><p>{request.reason || t("未填写外层说明")}</p>{canReviewRoles && request.canReview && <div className="rc-action-row rc-card-actions"><button className="rc-button" type="button" onClick={() => setPending({ kind: "decision", label: `${t("批准")} ${request.changeType}`, request, decision: "approve" })}>{t("批准")}</button><button className="rc-button rc-danger-button" type="button" onClick={() => setPending({ kind: "decision", label: `${t("拒绝")} ${request.changeType}`, request, decision: "reject" })}>{t("拒绝")}</button></div>}</article>)}</div>}</section>}
    <ConfirmActionDialog open={Boolean(pending)} title={pending?.label ?? t("权限变更")} description={pending?.kind === "decision" ? t("申请人与审批人必须分离；审批结果会写入当前应用授权审计。") : t("撤销会改变用户现有访问能力，并提交双人审批申请。")} confirmLabel={t("确认并记录")} busy={busy} onCancel={() => setPending(null)} onConfirm={(reason) => { if (pending) void execute(pending, reason); }} />
  </>;
}

function AccessAudit({ appId }: { appId: Exclude<AppAudience, "client"> }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ auditEvents: AuthorizationAuditEvent[] }>("/api/access/audit?limit=200", t("授权审计读取失败"));
  return <><PageHeading eyebrow="AUTHORIZATION AUDIT" title={t("授权审计")} description={`${t("仅展示")} ${appId} ${t("应用的授权变更事件。")}`} actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button>} />
    <section className="rc-panel">{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.auditEvents.length ? <EmptyState title={t("没有审计事件")} description={t("当前应用尚无授权变更记录。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("时间")}</th><th>{t("操作")}</th><th>{t("对象")}</th><th>{t("操作者")}</th></tr></thead><tbody>{resource.data.auditEvents.map((event) => <tr key={event.id}><td>{formatDateTime(event.createdAt, locale)}</td><td>{event.action}</td><td>{event.subjectType}<small>{event.subjectId}</small></td><td><small>{event.actorUserId || t("系统")}</small></td></tr>)}</tbody></table></div>}</section></>;
}
