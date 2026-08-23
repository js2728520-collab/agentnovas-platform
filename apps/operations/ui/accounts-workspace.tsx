"use client";

import { useMemo, useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type InternalAccount = {
  id: string;
  displayName: string;
  email: string;
  role: string;
  roleLabel: string;
  status: string;
  scopeLabel: string;
  createdAt: string;
  activeSessions: number;
  lastSeenAt: string | null;
  isCurrent: boolean;
};

export function AccountsWorkspace({ canManage }: { canManage: boolean }) {
  const resource = useApiData<{ accounts: InternalAccount[] }>(
    "/api/organization/members?view=accounts",
    "运营账号读取失败",
  );
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<InternalAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const accounts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return resource.data?.accounts ?? [];
    return (resource.data?.accounts ?? []).filter((account) => (
      `${account.displayName} ${account.email} ${account.roleLabel} ${account.status} ${account.scopeLabel}`
        .toLocaleLowerCase("zh-CN")
        .includes(needle)
    ));
  }, [query, resource.data?.accounts]);

  async function changeStatus(reason: string) {
    if (!pending || busy) return;
    const action = pending.status === "active" ? "deactivate" : "restore";
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/organization/members/${encodeURIComponent(pending.id)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "账号状态更新失败"));
      setMessage(String(payload.message ?? "账号状态已更新"));
      setPending(null);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号状态更新失败");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading
      eyebrow="ACCOUNTS"
      title="运营账号"
      description="平面查看账号、角色、权限范围与会话状态；此页面不提供层级关系管理。"
    />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-panel">
      <header>
        <div><small>ACCOUNT DIRECTORY</small><h2>内部账号生命周期</h2></div>
        <label>搜索账号<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="邮箱、角色或状态" /></label>
      </header>
      {resource.loading && !resource.data ? <LoadingState />
        : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} />
          : !accounts.length ? <EmptyState title="没有匹配账号" description="调整搜索条件后重试。" />
            : <div className="rc-table-wrap"><table>
              <thead><tr><th>账号</th><th>角色 / 数据范围</th><th>状态</th><th>会话</th><th>最近活动</th><th>操作</th></tr></thead>
              <tbody>{accounts.map((account) => <tr key={account.id}>
                <td><b>{account.displayName}</b><small>{account.email}</small></td>
                <td><b>{account.roleLabel}</b><small>{account.scopeLabel}</small></td>
                <td><StatusBadge value={account.status} /></td>
                <td>{account.activeSessions}</td>
                <td>{account.lastSeenAt ? formatDateTime(account.lastSeenAt) : `创建于 ${formatDateTime(account.createdAt)}`}</td>
                <td>{account.isCurrent || !canManage || !["active", "frozen"].includes(account.status)
                  ? <span className="rc-muted">只读</span>
                  : <button
                      className={account.status === "active" ? "rc-button rc-danger-button" : "rc-button"}
                      type="button"
                      disabled={busy}
                      onClick={() => setPending(account)}
                    >{account.status === "active" ? "停用" : "恢复"}</button>}</td>
              </tr>)}</tbody>
            </table></div>}
    </section>
    <ConfirmActionDialog
      open={pending !== null}
      title={pending?.status === "active" ? "停用运营账号" : "恢复运营账号"}
      description={pending?.status === "active"
        ? "停用会立即撤销该账号的全部会话、未使用令牌和其签发的有效权限注册链接。"
        : "恢复只允许账号重新登录，不会扩大原有角色或权限范围。"}
      confirmLabel="确认提交"
      busy={busy}
      onCancel={() => setPending(null)}
      onConfirm={(reason) => void changeStatus(reason)}
    />
  </>;
}
