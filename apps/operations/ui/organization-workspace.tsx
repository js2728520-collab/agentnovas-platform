"use client";

import { useState } from "react";

import OrganizationRelationshipTree from "@/app/organization-relationship-tree";
import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type TreeNode = { id: string; subjectId: string; kind: "member" | "customer"; displayName: string; email: string; role: string; roleLabel: string; status: string; organizationId: string | null; parentId: string | null };
type TreePayload = { rootId: string; nextRole: string | null; nextRoleLabel: string | null; nodes: TreeNode[]; summary: { organizations: number; members: number; customers: number; active: number } };
type OrganizationAction =
  | { kind: "invite" }
  | { kind: "relationship" }
  | { kind: "deactivate" | "restore" | "reinvite"; member: TreeNode };

export function OrganizationWorkspace({ canManage }: { canManage: boolean }) {
  const tree = useApiData<TreePayload>("/api/organization/members?view=tree", "组织关系读取失败");
  const [invite, setInvite] = useState({ email: "", name: "" });
  const [relationship, setRelationship] = useState({ memberId: "", newReportsToUserId: "" });
  const [auditReason, setAuditReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState("");
  const members = tree.data?.nodes.filter((node) => node.kind === "member") ?? [];
  // 只有创建分支管理员时才会顺带建分公司。名称留空会退化成邮箱前缀，
  // 而组织树、业绩归因、数据范围全挂在那个组织上——事后没人知道它是什么。
  const createsBranch = tree.data?.nextRole === "branch_admin";
  const branchNameReady = !createsBranch || invite.name.trim().length >= 2;
  const reasonReady = auditReason.trim().length >= 3 && auditReason.trim().length <= 500;

  async function submit(action: OrganizationAction) {
    const reason = auditReason.trim();
    if (busy || reason.length < 3 || reason.length > 500) return;
    setBusy(true); setMessage("正在提交组织操作…");
    try {
      const isMemberStatus = action.kind === "deactivate" || action.kind === "restore";
      const isReinvite = action.kind === "reinvite";
      const endpoint = isMemberStatus
        ? `/api/organization/members/${encodeURIComponent(action.member.subjectId)}/status`
        : isReinvite
          ? `/api/organization/members/${encodeURIComponent(action.member.subjectId)}/activate`
          : "/api/organization/members";
      const response = await fetch(endpoint, {
        method: isMemberStatus ? "PATCH" : action.kind === "relationship" ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action.kind === "invite" ? { ...invite, reason }
          : action.kind === "relationship" ? { ...relationship, reason }
            : isMemberStatus ? { action: action.kind, reason }
              : { reason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, action.kind === "invite" ? "成员邀请失败" : action.kind === "relationship" ? "汇报关系调整提交失败" : "成员状态操作失败"));
      setMessage(typeof payload.message === "string" ? payload.message : action.kind === "invite" ? "成员邀请已进入邮件队列。" : action.kind === "relationship" ? "汇报关系调整已提交双人复核。" : action.kind === "reinvite" ? "设置密码邀请已重新进入邮件队列。" : "成员状态已更新。");
      setAuditReason(""); setInvite({ email: "", name: "" }); setRelationship({ memberId: "", newReportsToUserId: "" });
      setRefreshKey(crypto.randomUUID()); await tree.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "组织操作失败"); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeading eyebrow="ORGANIZATION" title="组织架构" description="成员、上下级关系、客户归属和待审批调整均按显式 Operations 授权范围展示。" />
    <div className="rc-live" aria-live="polite">{message}</div>
    {canManage ? <section className="rc-panel"><header><div><small>AUDIT CONTEXT</small><h2>本次组织操作依据</h2></div><span className="rc-muted">服务端仍会校验权限、范围与状态</span></header><div className="rc-form"><label>审计原因（3–500 字）<textarea rows={2} minLength={3} maxLength={500} value={auditReason} onChange={(event) => setAuditReason(event.target.value)} placeholder="例如：按已批准工单调整团队成员" /></label><p className="rc-muted">邀请、汇报关系与账号状态接口仍会在服务端校验并记录原因；重新邀请继续校验操作者和成员范围。填写后直接点击目标操作，无需再次弹窗确认。</p></div></section> : null}
    {canManage ? <section className="rc-panel"><header><div><small>MEMBER LIFECYCLE</small><h2>邀请与汇报关系</h2></div><StatusBadge value="一次性设置密码" /></header><div className="rc-card-grid">
      <article className="rc-card"><h3>邀请下一级成员</h3><div className="rc-form"><label>成员邮箱<input type="email" maxLength={254} value={invite.email} onChange={(event) => setInvite((current) => ({ ...current, email: event.target.value }))} /></label>{createsBranch ? <label>分公司名称（必填，2–120 字）<input maxLength={120} value={invite.name} onChange={(event) => setInvite((current) => ({ ...current, name: event.target.value }))} /></label> : null}<button className="rc-primary" type="button" disabled={busy || !reasonReady || !invite.email.includes("@") || !branchNameReady} onClick={() => void submit({ kind: "invite" })}>发送设置密码邀请</button></div><p>{tree.data?.nextRoleLabel ? `将创建：${tree.data.nextRoleLabel}。` : ""}{createsBranch ? "同时创建一个分公司，组织树与业绩归因都挂在它下面。" : ""}不会生成或回显临时密码；邮件未送达前账户保持待激活。</p></article>
      <article className="rc-card"><h3>调整汇报关系</h3>{tree.loading && !tree.data ? <LoadingState /> : tree.error && !tree.data ? <ErrorState message={tree.error} retry={tree.refresh} /> : <div className="rc-form"><label>目标成员<select value={relationship.memberId} onChange={(event) => setRelationship((current) => ({ ...current, memberId: event.target.value }))}><option value="">请选择成员</option>{members.filter((member) => member.id !== tree.data?.rootId).map((member) => <option value={member.subjectId} key={member.id}>{member.displayName} · {member.roleLabel}</option>)}</select></label><label>新直属上级<select value={relationship.newReportsToUserId} onChange={(event) => setRelationship((current) => ({ ...current, newReportsToUserId: event.target.value }))}><option value="">请选择上级</option>{members.filter((member) => member.subjectId !== relationship.memberId).map((member) => <option value={member.subjectId} key={member.id}>{member.displayName} · {member.roleLabel}</option>)}</select></label><button className="rc-primary" type="button" disabled={busy || !reasonReady || !relationship.memberId || !relationship.newReportsToUserId} onClick={() => void submit({ kind: "relationship" })}>提交汇报关系调整</button></div>}<p>调整只进入审批队列，批准前当前汇报关系不变。</p></article>
    </div></section> : null}
    {canManage && members.length ? <section className="rc-panel"><header><div><small>ACCOUNT STATUS</small><h2>成员生命周期</h2></div><span className="rc-muted">停用会立即撤销会话；重新邀请会使旧邀请失效</span></header><div className="rc-table-wrap"><table><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{members.filter((member) => member.id !== tree.data?.rootId).map((member) => <tr key={member.id}><td><b>{member.displayName}</b><small>{member.email}</small></td><td>{member.roleLabel}</td><td><StatusBadge value={member.status} /></td><td><div className="rc-action-row">{member.status === "pending" ? <button className="rc-button" type="button" disabled={busy || !reasonReady} onClick={() => void submit({ kind: "reinvite", member })}>重新发送邀请</button> : member.status === "active" ? <button className="rc-button rc-danger-button" type="button" disabled={busy || !reasonReady} onClick={() => void submit({ kind: "deactivate", member })}>停用成员</button> : member.status === "frozen" ? <button className="rc-button" type="button" disabled={busy || !reasonReady} onClick={() => void submit({ kind: "restore", member })}>恢复成员</button> : <span className="rc-muted">历史账户只读</span>}</div></td></tr>)}</tbody></table></div></section> : null}
    <section className="rc-panel rc-legacy-embed"><OrganizationRelationshipTree refreshKey={refreshKey} /></section>
  </>;
}
