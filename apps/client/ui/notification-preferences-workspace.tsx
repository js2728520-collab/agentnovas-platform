"use client";

import ClientNotificationSettings from "./client-notification-settings";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import styles from "./client-notification-settings.module.css";

export function NotificationPreferencesWorkspace() {
  const { t } = useAppLocale();
  return <div className={styles.page}>
    <header className={styles.pageHeading}>
      <h1>{t("通知偏好")}</h1>
      <p>{t("设置站内和邮件通知的接收方式。安全、缴费和风险通知会始终保留站内记录。")}</p>
    </header>
    <ClientNotificationSettings />
  </div>;
}
