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
  const resource = useApiData<{ link: MyLink | null; canCreate: boolean }>(
    "/api/invitations/link",
    "邀请链接读取失败",
  );
  const staff = useApiData<{
    links: StaffLink[];
    invitableRoles: string[];
    organizations: Array<{ id: string; name: string }>;
  }>("/api/invitations/staff-link", "员工邀请链接读取失败");
  const experience = useApiData<{ account: ExperienceAccount | null }>(
    "/api/organization/experience-account",
    "体验账号读取失败",
  );
  const [issued, setIssued] = useState<{ link: string; replaced: boolean; kind: "customer" | "staff"; registrationLinkId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [selectedStaffRole, setSelectedStaffRole] = useState("");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");

  async function generate() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/invitations/link", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "生成邀请链接失败"));
      setIssued({ link: payload.link, replaced: Boolean(payload.replacedPreviousLink), kind: "customer" });
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成邀请链接失败");
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
      if (!response.ok) throw new Error(apiErrorMessage(payload, "生成权限注册链接失败"));
      setIssued({
        link: payload.link,
        replaced: Boolean(payload.replacedPreviousLink),
        kind: "staff",
        registrationLinkId: payload.registrationLink?.id,
      });
      await staff.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成权限注册链接失败");
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
      if (!response.ok) throw new Error(apiErrorMessage(payload, "作废权限注册链接失败"));
      setIssued(null);
      await staff.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "作废权限注册链接失败");
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading) return <LoadingState label="正在读取邀请链接…" />;
  if (resource.error) return <ErrorState message={resource.error} retry={resource.refresh} />;

  const existing = resource.data?.link ?? null;
  const canCreate = canManage && (resource.data?.canCreate ?? false);
  const effectiveStaffRole = selectedStaffRole || staff.data?.invitableRoles[0] || "";
  const staffOrganizationRequired = effectiveStaffRole !== "branch_admin" && Boolean(staff.data?.organizations.length);

  return (
    <section className={styles.workspace}>
      <PageHeading
        eyebrow="获客"
        title="我的邀请链接"
        description="一条链接反复使用，不需要为每个客户单独创建。通过它注册的客户会自动归因到你，以及你的上级与分公司。"
      />

      {message ? <p className={styles.message}>{message}</p> : null}

      {issued ? (
        <div className={styles.issued}>
          <h3 className={styles.issuedTitle}>
            {issued.kind === "staff" ? "权限注册链接" : "客户邀请链接"}
            {issued.replaced ? "已重新生成，旧链接失效" : "已生成"}
          </h3>
          <p className={styles.warning}>
            链接只在这里显示这一次。请立即保存——想要回它只能重新生成，
            而重新生成会让当前这条立刻失效。
            {issued.kind === "staff" ? "权限注册链接长期有效，直到手动作废或重新生成。" : ""}
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
              {copied ? "已复制" : "复制"}
            </button>
          </div>
        </div>
      ) : null}

      {existing ? (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <StatusBadge value={existing.status === "active" ? "生效中" : existing.status} />
            <span className={styles.meta}>{formatDateTime(existing.createdAt)} 创建</span>
          </div>
          <dl className={styles.stats}>
            <div>
              <dt>已带来注册</dt>
              <dd className={styles.count}>{existing.useCount}</dd>
            </div>
            <div>
              <dt>最近一次使用</dt>
              <dd>{existing.lastUsedAt ? formatDateTime(existing.lastUsedAt) : "尚未被使用"}</dd>
            </div>
          </dl>
          <p className={styles.note}>
            链接明文不保存在系统里，因此这里显示不出它本身。
            如果链接丢了或需要作废，重新生成一条。
          </p>
          {canCreate ? (
            <button className={styles.danger} type="button" disabled={busy} onClick={generate}>
              {busy ? "正在重新生成…" : "重新生成（当前链接立即失效）"}
            </button>
          ) : null}
        </div>
      ) : (
        <EmptyState
          title="还没有邀请链接"
          description={canCreate
            ? "生成一条之后就可以一直用，不需要为每个客户单独创建。"
            : "当前角色不能生成邀请链接，请联系上级。"}
        />
      )}

      {!existing && canCreate ? (
        <button className={styles.primary} type="button" disabled={busy} onClick={generate}>
          生成我的邀请链接
        </button>
      ) : null}

      <section className={styles.staffSection}>
        <PageHeading
          eyebrow="团队"
          title="权限注册链接"
          description="按低于你的角色生成长期可复用链接。注册者不能选择或扩大权限，注册成功后账号与权限立即生效。"
        />
        {staff.loading ? <LoadingState label="正在读取权限注册链接…" /> : null}
        {staff.error ? <ErrorState message={staff.error} retry={staff.refresh} /> : null}
        {!staff.loading && !staff.error ? (
          staff.data?.invitableRoles.length ? (
            <>
              {canManage ? (
                <div className={styles.engageForm}>
                  <div className={styles.formRow}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>授予角色</span>
                      <select
                        className={styles.select}
                        value={effectiveStaffRole}
                        onChange={(event) => {
                          setSelectedStaffRole(event.target.value);
                          setSelectedOrganizationId("");
                        }}
                      >
                        {staff.data.invitableRoles.map((role) => (
                          <option key={role} value={role}>{internalRoleLabels[role] ?? role}</option>
                        ))}
                      </select>
                    </label>
                    {effectiveStaffRole !== "branch_admin" && staff.data.organizations.length ? (
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>锁定分公司</span>
                        <select
                          className={styles.select}
                          value={selectedOrganizationId}
                          onChange={(event) => setSelectedOrganizationId(event.target.value)}
                        >
                          <option value="">请选择分公司</option>
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
                      生成或重新生成链接
                    </button>
                  </div>
                  <p className={styles.note}>同一角色和分公司重新生成时，旧链接在同一事务中立即作废。</p>
                </div>
              ) : null}
              {staff.data.links.length ? (
                <ul className={styles.list}>
                  {staff.data.links.map((link) => (
                    <li className={`${styles.card} ${link.status === "revoked" ? styles.released : ""}`} key={link.id}>
                      <div className={styles.cardHead}>
                        <StatusBadge value={link.status === "active" ? "生效中" : "已作废"} />
                        <strong>{link.targetRoleLabel}</strong>
                      </div>
                      <p className={styles.note}>
                        范围：{link.organizationMode === "CREATE_BRANCH" ? "注册时创建分公司" : link.organizationName ?? link.organizationId}
                      </p>
                      <p className={styles.note}>权限 {link.permissionSnapshot.length} 项 · 创建人：当前账号</p>
                      <dl className={styles.stats}>
                        <div><dt>注册次数</dt><dd className={styles.count}>{link.useCount}</dd></div>
                        <div><dt>最近使用</dt><dd>{link.lastUsedAt ? formatDateTime(link.lastUsedAt) : "尚未使用"}</dd></div>
                        <div><dt>创建时间</dt><dd>{formatDateTime(link.createdAt)}</dd></div>
                      </dl>
                      {link.status === "active" && canManage ? (
                        <button className={styles.danger} type="button" disabled={busy} onClick={() => revokeStaffLink(link.id)}>
                          立即作废
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="还没有权限注册链接" description="选择一个低于你的角色后生成。" />}
            </>
          ) : (
            <EmptyState
              title="当前角色不能生成权限注册链接"
              description="员工没有下级角色，不能继续向下授权。"
            />
          )
        ) : null}
      </section>

      <section className={styles.staffSection}>
        <PageHeading
          eyebrow="熟悉业务"
          title="我的体验账号"
          description="一个独立的客户账号，用来从客户视角看产品。它不计入任何业绩统计——否则用自己的账号交易会算成自己的业绩。"
        />
        {experience.loading ? <LoadingState label="正在读取体验账号…" /> : null}
        {experience.error ? <ErrorState message={experience.error} retry={experience.refresh} /> : null}
        {!experience.loading && !experience.error ? (
          experience.data?.account ? (
            <div className={styles.card}>
              <p className={styles.note}>
                已开通：<code className={styles.link}>{experience.data.account.email}</code>
              </p>
              <p className={styles.note}>用途：{experience.data.account.reason}</p>
              <p className={styles.note}>
                用这个邮箱和密码登录<strong>客户端</strong>即可。它是独立账号，与工号账号互不影响。
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
                  if (!response.ok) throw new Error(apiErrorMessage(payload, "开通体验账号失败"));
                  setMessage(String(payload.message ?? "体验账号已开通"));
                  await experience.refresh();
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : "开通体验账号失败");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <h3 className={styles.formTitle}>开通体验账号</h3>
              <p className={styles.formNote}>
                需要一个与工号账号不同的邮箱——同一个邮箱注册两个账号，登录时分不清进的是哪一个。
                每人只能开通一个。
              </p>
              <div className={styles.formRow}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>邮箱</span>
                  <input className={styles.input} name="email" type="email" required />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>手机号</span>
                  <input className={styles.input} name="phone" required />
                </label>
              </div>
              <div className={styles.formRow}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>密码（至少 12 位）</span>
                  <input className={styles.input} name="password" type="password" minLength={12} required />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>用途</span>
                  <input className={styles.input} name="reason" placeholder="例如：熟悉客户端下单流程" required />
                </label>
              </div>
              <button className={styles.secondary} type="submit" disabled={busy}>开通</button>
            </form>
          )
        ) : null}
      </section>

      <section className={styles.explainer}>
        <h3 className={styles.sectionTitle}>这条链接是怎么工作的</h3>
        <ul className={styles.list}>
          <li>链接里带你的识别码，注册时系统据此把客户归因到你、你的上级和分公司。</li>
          <li>可以无限次使用，发给一个人和发给一百个人是同一条链接。</li>
          <li>「已带来注册」的数字异常上涨，通常意味着链接被转发到了预期之外的地方。</li>
          <li>重新生成会让旧链接立刻失效——这也是撤销一条外泄链接的唯一办法。</li>
        </ul>
      </section>

    </section>
  );
}
