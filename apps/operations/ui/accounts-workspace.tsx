"use client";

import { useMemo, useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

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
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ accounts: InternalAccount[] }>(
    "/api/organization/members?view=accounts",
    t("运营账号读取失败"),
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const accounts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    if (!needle) return resource.data?.accounts ?? [];
    return (resource.data?.accounts ?? []).filter((account) => (
      `${account.displayName} ${account.email} ${account.roleLabel} ${account.status} ${account.scopeLabel}`
        .toLocaleLowerCase(locale)
        .includes(needle)
    ));
  }, [locale, query, resource.data?.accounts]);

  async function changeStatus(account: InternalAccount) {
    if (busy) return;
    const action = account.status === "active" ? "deactivate" : "restore";
    setBusy(true);
    setMessage(t("正在更新账号状态…"));
    try {
      const response = await fetch(`/api/organization/members/${encodeURIComponent(account.id)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, t("账号状态更新失败")));
      setMessage(String(payload.message ?? t("账号状态已更新")));
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("账号状态更新失败"));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading
      eyebrow="ACCOUNTS"
      title={t("运营账号")}
      description={t("平面查看账号、角色、权限范围与会话状态；此页面不提供层级关系管理。")}
    />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-panel">
      <header>
        <div><small>ACCOUNT DIRECTORY</small><h2>{t("内部账号生命周期")}</h2></div>
        <label>{t("搜索账号")}<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("邮箱、角色或状态")} /></label>
      </header>
      {canManage ? <p className="rc-muted">{t("停用会立即撤销全部会话、未使用令牌和该账号签发的有效权限注册链接；恢复只允许重新登录，不会扩大原有权限。操作者、目标、动作和结果由服务端自动留痕。")}</p> : null}
      {resource.loading && !resource.data ? <LoadingState />
        : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} />
          : !accounts.length ? <EmptyState title={t("没有匹配账号")} description={t("调整搜索条件后重试。")} />
            : <div className="rc-table-wrap"><table>
              <thead><tr><th>{t("账号")}</th><th>{t("角色 / 数据范围")}</th><th>{t("状态")}</th><th>{t("会话")}</th><th>{t("最近活动")}</th><th>{t("操作")}</th></tr></thead>
              <tbody>{accounts.map((account) => <tr key={account.id}>
                <td><b>{account.displayName}</b><small>{account.email}</small></td>
                <td><b>{t(account.roleLabel)}</b><small>{account.scopeLabel}</small></td>
                <td><StatusBadge value={account.status} /></td>
                <td>{account.activeSessions}</td>
                <td>{account.lastSeenAt ? formatDateTime(account.lastSeenAt, locale) : `${t("创建于")} ${formatDateTime(account.createdAt, locale)}`}</td>
                <td>{account.isCurrent || !canManage || !["active", "frozen"].includes(account.status)
                  ? <span className="rc-muted">{t("只读")}</span>
                  : <button
                      className={account.status === "active" ? "rc-button rc-danger-button" : "rc-button"}
                      type="button"
                      disabled={busy}
                      onClick={() => void changeStatus(account)}
                    >{account.status === "active" ? t("停用") : t("恢复")}</button>}</td>
              </tr>)}</tbody>
            </table></div>}
    </section>
  </>;
}
