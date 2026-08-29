"use client";

import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import styles from "./readiness-workspace.module.css";
import { readinessCopy, type ReadinessCheck } from "./readiness-presentation";

/**
 * 开服就绪清单。
 *
 * 首次上线要配的东西散在至少六处，此前「还差什么」这个问题没有答案，只能靠人翻手册。
 * 这个页面把它变成一屏——每一项都说清「现状是什么」和「该做什么」。
 *
 * 上线后它不会失效：某天有人把披露下架，或某个 Agent 角色的模型被停用，这里会变红。
 */

const STATUS_LABELS: Record<ReadinessCheck["status"], string> = {
  ready: "已就绪",
  partial: "部分完成",
  missing: "未配置",
};

export function ReadinessWorkspace() {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ checks: ReadinessCheck[]; blockingCount: number; readyCount: number }>(
    "/api/maintenance/readiness",
    t("就绪清单读取失败"),
  );

  if (resource.loading && !resource.data) return <LoadingState label={t("正在检查平台就绪状态…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;

  const { checks = [], blockingCount = 0, readyCount = 0 } = resource.data ?? {};

  return (
    <section className={styles.workspace}>
      <PageHeading
        eyebrow={t("开服准备")}
        title={t("平台就绪清单")}
        description={t("只读检查，不替你做任何配置——七项披露要双人审批、支付凭证要人工填，自动化它们等于绕过治理控制。")}
        actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("重新检查")}</button>}
      />

      <div className={blockingCount > 0 ? styles.summaryBlocked : styles.summaryReady} role="status">
        {blockingCount > 0
          ? <><strong>{t("还有")} {blockingCount} {t("项阻塞开服")}</strong>{t("——这些项未完成时，客户无法完成核心流程。")}</>
          : <><strong>{t("阻塞项已全部完成")}</strong>（{readyCount}/{checks.length} {t("项就绪")}）。{t("剩余的警告项不阻断开服。")}</>}
      </div>

      <ul className={styles.list}>
        {checks.map((check) => {
          const copy = readinessCopy(check, locale);
          return <li key={check.key} className={`${styles.item} ${styles[check.status]}`}>
            <div className={styles.itemHead}>
              <span className={styles.mark} aria-hidden>
                {check.status === "ready" ? "✓" : check.severity === "blocking" ? "✕" : "!"}
              </span>
              <b>{copy.label}</b>
              <StatusBadge value={t(STATUS_LABELS[check.status])} />
              {check.severity === "blocking" && check.status !== "ready"
                ? <span className={styles.blocking}>{t("阻塞开服")}</span>
                : null}
            </div>
            <p className={styles.detail}>{copy.detail}</p>
            {/* 只在没做完时显示动作——已就绪的项显示「该做什么」是噪音。 */}
            {copy.action ? <p className={styles.action}>{copy.action}</p> : null}
          </li>
        })}
      </ul>
    </section>
  );
}
