"use client";

import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

import styles from "./readiness-workspace.module.css";

/**
 * 开服就绪清单。
 *
 * 首次上线要配的东西散在至少六处，此前「还差什么」这个问题没有答案，只能靠人翻手册。
 * 这个页面把它变成一屏——每一项都说清「现状是什么」和「该做什么」。
 *
 * 上线后它不会失效：某天有人把披露下架，或某个 Agent 角色的模型被停用，这里会变红。
 */

type ReadinessCheck = {
  key: string;
  label: string;
  status: "ready" | "missing" | "partial";
  severity: "blocking" | "warning" | "info";
  detail: string;
  action: string | null;
};

const STATUS_LABELS: Record<ReadinessCheck["status"], string> = {
  ready: "已就绪",
  partial: "部分完成",
  missing: "未配置",
};

export function ReadinessWorkspace() {
  const resource = useApiData<{ checks: ReadinessCheck[]; blockingCount: number; readyCount: number }>(
    "/api/maintenance/readiness",
    "就绪清单读取失败",
  );

  if (resource.loading && !resource.data) return <LoadingState label="正在检查平台就绪状态…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;

  const { checks = [], blockingCount = 0, readyCount = 0 } = resource.data ?? {};

  return (
    <section className={styles.workspace}>
      <PageHeading
        eyebrow="开服准备"
        title="平台就绪清单"
        description="只读检查，不替你做任何配置——七项披露要双人审批、支付凭证要人工填，自动化它们等于绕过治理控制。"
        actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>重新检查</button>}
      />

      <div className={blockingCount > 0 ? styles.summaryBlocked : styles.summaryReady} role="status">
        {blockingCount > 0
          ? <><strong>还有 {blockingCount} 项阻塞开服</strong>——这些项未完成时，客户无法完成核心流程。</>
          : <><strong>阻塞项已全部完成</strong>（{readyCount}/{checks.length} 项就绪）。剩余的警告项不阻断开服。</>}
      </div>

      <ul className={styles.list}>
        {checks.map((check) => (
          <li key={check.key} className={`${styles.item} ${styles[check.status]}`}>
            <div className={styles.itemHead}>
              <span className={styles.mark} aria-hidden>
                {check.status === "ready" ? "✓" : check.severity === "blocking" ? "✕" : "!"}
              </span>
              <b>{check.label}</b>
              <StatusBadge value={STATUS_LABELS[check.status]} />
              {check.severity === "blocking" && check.status !== "ready"
                ? <span className={styles.blocking}>阻塞开服</span>
                : null}
            </div>
            <p className={styles.detail}>{check.detail}</p>
            {/* 只在没做完时显示动作——已就绪的项显示「该做什么」是噪音。 */}
            {check.action ? <p className={styles.action}>{check.action}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
