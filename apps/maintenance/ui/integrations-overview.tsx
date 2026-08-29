"use client";

import Link from "next/link";

import type { MaintenanceEmailStatus, MaintenancePaymentProvider } from "@/packages/contracts/src/riverton-ui";
import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export function IntegrationsOverview({
  canViewEmail,
  canViewPayments,
  canViewDemo,
}: {
  canViewEmail: boolean;
  canViewPayments: boolean;
  canViewDemo: boolean;
}) {
  const { t } = useAppLocale();
  const email = useApiData<MaintenanceEmailStatus>(
    canViewEmail ? "/api/maintenance/email/status" : null,
    t("邮件状态读取失败"),
  );
  const payments = useApiData<{ providers: MaintenancePaymentProvider[] }>(
    canViewPayments ? "/api/maintenance/payment-providers" : null,
    t("支付状态读取失败"),
  );
  const activePayments = payments.data?.providers.filter((provider) => provider.effectiveStatus === "active").length;
  return <><PageHeading eyebrow="INTEGRATIONS" title={t("服务集成")} description={t("安全查看邮件、优盾充值与 Demo 配置状态；配置存在不等于服务正在运行。")} /><section className="rc-link-grid rc-integration-grid">{canViewEmail && <Link href="/integrations?tab=email"><StatusBadge value={email.data?.configured ? "configured" : email.loading ? "loading" : "unconfigured"} /><small>{t("Resend 邮件")} · {email.data?.apiKeyPresent ? t("密钥存在") : t("密钥缺失")}</small></Link>}{canViewPayments && <Link href="/integrations?tab=payments"><StatusBadge value={activePayments ? "active" : payments.loading ? "loading" : "disabled"} /><small>{t("优盾充值")} · {activePayments ?? "—"} {t("个有效网络")}</small></Link>}{canViewDemo && <Link href="/integrations?tab=demo"><StatusBadge value="safe view" /><small>{t("Demo 现货账户、验证与停控")}</small></Link>}</section>{(email.error || payments.error) && <div className="rc-inline-error" role="alert">{email.error || payments.error}</div>}</>;
}
