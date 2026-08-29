"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import styles from "./invitations-workspace.module.css";

type ExperienceAccount = { customerId: string; email: string; reason: string; createdAt: string | null };

type StaffLink = {
  id: string;
  targetRole: string;
  targetRoleLabel: string;
  organizationMode: "CREATE_BRANCH" | "EXISTING_ORGANIZATION";
  organizationId: string | null;
  organizationName: string | null;
  permissionSnapshot: Array<{ permission_key: string; scope: string }>;
  status: "active" | "revoked";
  useCount: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
};

type MyLink = {
  id: string;
  status: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  plaintextAvailable: boolean;
};

const internalRoleLabels: Record<string, string> = {
  branch_admin: "分公司总经理",
  manager: "经理",
  supervisor: "主管",
  employee: "员工",
};

export function InvitationsWorkspace({ canManage }: { canManage: boolean }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ link: MyLink | null; canCreate: boolean }>(
    "/api/invitations/link",
    t("邀请链接读取失败"),
  );
  const staff = useApiData<{
    links: StaffLink[];
    invitableRoles: string[];
    organizations: Array<{ id: string; name: string }>;
  }>("/api/invitations/staff-link", t("员工邀请链接读取失败"));
  const experience = useApiData<{ account: ExperienceAccount | null }>(
    "/api/organization/experience-account",
    t("体验账号读取失败"),
  );
  const [issued, setIssued] = useState<{ link: string; replaced: boolean; kind: "customer" | "staff"; registrationLinkId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [selectedStaffRole, setSelectedStaffRole] = useState("");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [activePanel, setActivePanel] = useState<"customer" | "staff" | "experience">("customer");

  function localizedApiError(payload: unknown, fallbackKey: string) {
    const fallback = t(fallbackKey);
    const detail = apiErrorMessage(payload, fallback);
    return locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback;
  }

  async function generate() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/invitations/link", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizedApiError(payload, "生成邀请链接失败"));
      setIssued({ link: payload.link, replaced: Boolean(payload.replacedPreviousLink), kind: "customer" });
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("生成邀请链接失败"));
    } finally {
      setBusy(false);
    }
  }

  async function generateStaffLink() {
    if (busy) return;
    const targetRole = selectedStaffRole || staff.data?.invitableRoles[0] || "";
    if (!targetRole) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/invitations/staff-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetRole,
          organizationId: targetRole === "branch_admin" ? null : selectedOrganizationId || null,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizedApiError(payload, "生成权限注册链接失败"));
      setIssued({
        link: payload.link,
        replaced: Boolean(payload.replacedPreviousLink),
        kind: "staff",
        registrationLinkId: payload.registrationLink?.id,
      });
      await staff.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("生成权限注册链接失败"));
    } finally {
      setBusy(false);
    }
  }

  async function revokeStaffLink(linkId: string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/invitations/staff-link", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ linkId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizedApiError(payload, "作废权限注册链接失败"));
      setIssued(null);
      await staff.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("作废权限注册链接失败"));
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading) return <LoadingState label={t("正在读取邀请链接…")} />;
  if (resource.error) return <ErrorState message={resource.error} retry={resource.refresh} />;

  const existing = resource.data?.link ?? null;
  const canCreate = canManage && (resource.data?.canCreate ?? false);
  const effectiveStaffRole = selectedStaffRole || staff.data?.invitableRoles[0] || "";
  const staffOrganizationRequired = effectiveStaffRole !== "branch_admin" && Boolean(staff.data?.organizations.length);

  return (
    <section className={styles.workspace}>
      <PageHeading
        eyebrow={t("运营治理")}
        title={t("注册链接")}
        description={t("集中管理客户邀请、员工授权链接与独立体验账号。")}
      />

      {message ? <p className={styles.message}>{message}</p> : null}

      <div className="rc-action-row" role="tablist" aria-label={t("注册链接类型")}>
        {([
          ["customer", t("客户邀请")],
          ["staff", t("员工授权")],
          ["experience", t("体验账号")],
        ] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={activePanel === value} className={activePanel === value ? "rc-primary" : "rc-button"} onClick={() => { setActivePanel(value); setIssued(null); setCopied(false); }}>{label}</button>)}
      </div>

      {issued && ((activePanel === "staff") === (issued.kind === "staff")) ? (
        <div className={styles.issued}>
          <h3 className={styles.issuedTitle}>
            {issued.kind === "staff" ? t("权限注册链接") : t("客户邀请链接")}
            {issued.replaced ? ` · ${t("已重新生成，旧链接失效")}` : ` · ${t("已生成")}`}
          </h3>
          <p className={styles.warning}>
            {t("链接只在这里显示一次，请立即保存；重新生成会让当前链接立刻失效。")}
            {issued.kind === "staff" ? ` ${t("权限注册链接长期有效，直到手动作废或重新生成。")}` : ""}
          </p>
          <div className={styles.linkRow}>
            <code className={styles.link}>{issued.link}</code>
            <button
              className={styles.secondary}
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(issued.link);
                if (issued.kind === "staff" && issued.registrationLinkId) {
                  await fetch("/api/invitations/staff-link", {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ linkId: issued.registrationLinkId, action: "copied" }),
                  });
                }
                setCopied(true);
              }}
            >
              {copied ? t("已复制") : t("复制")}
            </button>
          </div>
        </div>
      ) : null}

      {activePanel === "customer" ? <>{existing ? (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <StatusBadge value={existing.status === "active" ? t("生效中") : existing.status} />
            <span className={styles.meta}>{formatDateTime(existing.createdAt, locale)} {t("创建")}</span>
          </div>
          <dl className={styles.stats}>
            <div>
              <dt>{t("已带来注册")}</dt>
              <dd className={styles.count}>{existing.useCount}</dd>
            </div>
            <div>
              <dt>{t("最近一次使用")}</dt>
              <dd>{existing.lastUsedAt ? formatDateTime(existing.lastUsedAt, locale) : t("尚未被使用")}</dd>
            </div>
          </dl>
          <p className={styles.note}>
            {t("链接明文不保存在系统里；如果链接丢失或需要作废，请重新生成。")}
          </p>
          {canCreate ? (
            <button className={styles.danger} type="button" disabled={busy} onClick={generate}>
              {busy ? t("正在重新生成…") : t("重新生成（当前链接立即失效）")}
            </button>
          ) : null}
        </div>
      ) : (
        <EmptyState
          title={t("还没有邀请链接")}
          description={canCreate
            ? t("生成后可重复使用，不需要为每个客户单独创建。")
            : t("当前角色不能生成邀请链接，请联系上级。")}
        />
      )}

      {!existing && canCreate ? (
        <button className={styles.primary} type="button" disabled={busy} onClick={generate}>
          {t("生成我的邀请链接")}
        </button>
      ) : null}</> : null}

      {activePanel === "staff" ? <section className={styles.staffSection}>
        <header><div><small>{t("团队")}</small><h2>{t("权限注册链接")}</h2><p>{t("按低于你的角色生成长期可复用链接。注册者不能选择或扩大权限。")}</p></div></header>
        {staff.loading ? <LoadingState label={t("正在读取权限注册链接…")} /> : null}
        {staff.error ? <ErrorState message={staff.error} retry={staff.refresh} /> : null}
        {!staff.loading && !staff.error ? (
          staff.data?.invitableRoles.length ? (
            <>
              {canManage ? (
                <div className={styles.engageForm}>
                  <div className={styles.formRow}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t("授予角色")}</span>
                      <select
                        className={styles.select}
                        value={effectiveStaffRole}
                        onChange={(event) => {
                          setSelectedStaffRole(event.target.value);
                          setSelectedOrganizationId("");
                        }}
                      >
                        {staff.data.invitableRoles.map((role) => (
                          <option key={role} value={role}>{t(internalRoleLabels[role] ?? role)}</option>
                        ))}
                      </select>
                    </label>
                    {effectiveStaffRole !== "branch_admin" && staff.data.organizations.length ? (
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>{t("锁定分公司")}</span>
                        <select
                          className={styles.select}
                          value={selectedOrganizationId}
                          onChange={(event) => setSelectedOrganizationId(event.target.value)}
                        >
                          <option value="">{t("请选择分公司")}</option>
                          {staff.data.organizations.map((organization) => (
                            <option key={organization.id} value={organization.id}>{organization.name}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <button
                      className={styles.secondary}
                      type="button"
                      disabled={busy || (staffOrganizationRequired && !selectedOrganizationId)}
                      onClick={generateStaffLink}
                    >
                      {t("生成或重新生成链接")}
                    </button>
                  </div>
                  <p className={styles.note}>{t("同一角色和分公司重新生成时，旧链接在同一事务中立即作废。")}</p>
                </div>
              ) : null}
              {staff.data.links.length ? (
                <ul className={styles.list}>
                  {staff.data.links.map((link) => (
                    <li className={`${styles.card} ${link.status === "revoked" ? styles.released : ""}`} key={link.id}>
                      <div className={styles.cardHead}>
                        <StatusBadge value={t(link.status === "active" ? "生效中" : "已作废")} />
                        <strong>{t(link.targetRoleLabel)}</strong>
                      </div>
                      <p className={styles.note}>
                        {t("范围：")}{link.organizationMode === "CREATE_BRANCH" ? t("注册时创建分公司") : link.organizationName ?? link.organizationId}
                      </p>
                      <p className={styles.note}>{t("权限")} {link.permissionSnapshot.length} {t("项")} · {t("创建人：当前账号")}</p>
                      <dl className={styles.stats}>
                        <div><dt>{t("注册次数")}</dt><dd className={styles.count}>{link.useCount}</dd></div>
                        <div><dt>{t("最近使用")}</dt><dd>{link.lastUsedAt ? formatDateTime(link.lastUsedAt, locale) : t("尚未使用")}</dd></div>
                        <div><dt>{t("创建时间")}</dt><dd>{formatDateTime(link.createdAt, locale)}</dd></div>
                      </dl>
                      {link.status === "active" && canManage ? (
                        <button className={styles.danger} type="button" disabled={busy} onClick={() => revokeStaffLink(link.id)}>
                          {t("立即作废")}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title={t("还没有权限注册链接")} description={t("选择一个低于你的角色后生成。")} />}
            </>
          ) : (
            <EmptyState
              title={t("当前角色不能生成权限注册链接")}
              description={t("员工没有下级角色，不能继续向下授权。")}
            />
          )
        ) : null}
      </section> : null}

      {activePanel === "experience" ? <section className={styles.staffSection}>
        <header><div><small>{t("熟悉业务")}</small><h2>{t("我的体验账号")}</h2><p>{t("独立客户账号用于查看客户端，不计入任何业绩统计。")}</p></div></header>
        {experience.loading ? <LoadingState label={t("正在读取体验账号…")} /> : null}
        {experience.error ? <ErrorState message={experience.error} retry={experience.refresh} /> : null}
        {!experience.loading && !experience.error ? (
          experience.data?.account ? (
            <div className={styles.card}>
              <p className={styles.note}>
                {t("已开通：")}<code className={styles.link}>{experience.data.account.email}</code>
              </p>
              <p className={styles.note}>{t("用途：")}{experience.data.account.reason}</p>
              <p className={styles.note}>
                {t("使用该邮箱和密码登录客户端；它与工号账号相互独立。")}
              </p>
            </div>
          ) : (
            <form
              className={styles.engageForm}
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy) return;
                const data = new FormData(event.currentTarget);
                setBusy(true);
                setMessage("");
                try {
                  const response = await fetch("/api/organization/experience-account", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      email: String(data.get("email") ?? ""),
                      phone: String(data.get("phone") ?? ""),
                      password: String(data.get("password") ?? ""),
                      reason: String(data.get("reason") ?? ""),
                    }),
                  });
                  const payload = await response.json().catch(() => ({}));
                  if (!response.ok) throw new Error(localizedApiError(payload, "开通体验账号失败"));
                  setMessage(typeof payload.message === "string" && (locale === "zh-CN" || !/[\u3400-\u9fff]/.test(payload.message)) ? payload.message : t("体验账号已开通"));
                  await experience.refresh();
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : t("开通体验账号失败"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <h3 className={styles.formTitle}>{t("开通体验账号")}</h3>
              <p className={styles.formNote}>
                {t("请使用与工号账号不同的邮箱；每人只能开通一个体验账号。")}
              </p>
              <div className={styles.formRow}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t("邮箱")}</span>
                  <input className={styles.input} name="email" type="email" required />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t("手机号")}</span>
                  <input className={styles.input} name="phone" required />
                </label>
              </div>
              <div className={styles.formRow}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t("密码（至少 12 位）")}</span>
                  <input className={styles.input} name="password" type="password" minLength={12} required />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t("用途")}</span>
                  <input className={styles.input} name="reason" placeholder={t("例如：熟悉客户端下单流程")} required />
                </label>
              </div>
              <button className={styles.secondary} type="submit" disabled={busy}>{t("开通")}</button>
            </form>
          )
        ) : null}
      </section> : null}

    </section>
  );
}
