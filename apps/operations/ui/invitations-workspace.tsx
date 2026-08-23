"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

import styles from "./invitations-workspace.module.css";

type StaffLink = {
  id: string;
  status: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  targetRoleLabel: string | null;
};

type MyLink = {
  id: string;
  status: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  plaintextAvailable: boolean;
};

export function InvitationsWorkspace({ canManage }: { canManage: boolean }) {
  const resource = useApiData<{ link: MyLink | null; canCreate: boolean }>(
    "/api/invitations/link",
    "邀请链接读取失败",
  );
  const staff = useApiData<{
    link: StaffLink | null;
    targetRole: string | null;
    targetRoleLabel: string | null;
  }>("/api/invitations/staff-link", "员工邀请链接读取失败");
  const [issued, setIssued] = useState<{ link: string; replaced: boolean; kind: "customer" | "staff"; expiresAt?: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/invitations/link", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "生成邀请链接失败"));
      setIssued({ link: payload.link, replaced: Boolean(payload.replacedPreviousLink), kind: "customer" });
      setConfirming(false);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成邀请链接失败");
    } finally {
      setBusy(false);
    }
  }

  async function generateStaffLink() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/invitations/staff-link", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "生成员工邀请链接失败"));
      setIssued({
        link: payload.link,
        replaced: Boolean(payload.replacedPreviousLink),
        kind: "staff",
        expiresAt: payload.expiresAt,
      });
      await staff.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成员工邀请链接失败");
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading) return <LoadingState label="正在读取邀请链接…" />;
  if (resource.error) return <ErrorState message={resource.error} retry={resource.refresh} />;

  const existing = resource.data?.link ?? null;
  const canCreate = canManage && (resource.data?.canCreate ?? false);

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
            {issued.kind === "staff" ? "员工邀请链接" : "客户邀请链接"}
            {issued.replaced ? "已重新生成，旧链接失效" : "已生成"}
          </h3>
          <p className={styles.warning}>
            链接只在这里显示这一次。请立即保存——想要回它只能重新生成，
            而重新生成会让当前这条立刻失效。
            {issued.expiresAt ? `本链接将于 ${formatDateTime(issued.expiresAt)} 自动失效。` : ""}
          </p>
          <div className={styles.linkRow}>
            <code className={styles.link}>{issued.link}</code>
            <button
              className={styles.secondary}
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(issued.link);
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
            <button className={styles.danger} type="button" disabled={busy} onClick={() => setConfirming(true)}>
              重新生成（当前链接立即失效）
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
          title="邀请下一级同事"
          description="链接指向对方该进的那个端，48 小时后自动失效。通过它注册的人需要另一位管理员复核后才能登录。"
        />
        {staff.loading ? <LoadingState label="正在读取员工邀请链接…" /> : null}
        {staff.error ? <ErrorState message={staff.error} retry={staff.refresh} /> : null}
        {!staff.loading && !staff.error ? (
          staff.data?.targetRole ? (
            <div className={styles.card}>
              <p className={styles.note}>
                你可以邀请的是：<strong>{staff.data.targetRoleLabel}</strong>。
                角色由汇报关系推出，不可自选——能自选角色等于能给自己造上级。
              </p>
              {staff.data.link ? (
                <>
                  <dl className={styles.stats}>
                    <div>
                      <dt>已通过链接注册</dt>
                      <dd className={styles.count}>{staff.data.link.useCount}</dd>
                    </div>
                    <div>
                      <dt>失效时间</dt>
                      <dd>{staff.data.link.expiresAt ? formatDateTime(staff.data.link.expiresAt) : "—"}</dd>
                    </div>
                  </dl>
                  <p className={styles.note}>
                    链接明文不保存在系统里。重新生成会让当前链接立即失效。
                  </p>
                </>
              ) : (
                <p className={styles.note}>当前没有生效中的员工邀请链接。</p>
              )}
              {canManage ? (
                <button className={styles.secondary} type="button" disabled={busy} onClick={generateStaffLink}>
                  {staff.data.link ? "重新生成员工邀请链接" : "生成员工邀请链接"}
                </button>
              ) : null}
            </div>
          ) : (
            <EmptyState
              title="当前角色没有可邀请的下一级"
              description="技术人员由总公司管理员在成员页直接创建，不走这条汇报链。"
            />
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

      {confirming ? (
        <ConfirmActionDialog
          open
          title="重新生成邀请链接"
          description="当前链接会立刻失效，已经拿到它但还没注册的人将无法完成注册。新链接只显示一次。"
          confirmLabel="重新生成"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={generate}
        />
      ) : null}
    </section>
  );
}
