"use client";

import Link from "next/link";

import type { MaintenanceEmailStatus, MaintenancePaymentProvider } from "@/packages/contracts/src/riverton-ui";
import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

export function IntegrationsOverview({ canViewDemo }: { canViewDemo: boolean }) {
  const email = useApiData<MaintenanceEmailStatus>("/api/maintenance/email/status", "邮件状态读取失败");
  const payments = useApiData<{ providers: MaintenancePaymentProvider[] }>("/api/maintenance/payment-providers", "支付状态读取失败");
  return <><PageHeading eyebrow="INTEGRATIONS" title="服务集成" description="安全查看邮件、支付与 Demo 配置状态；配置存在不等于服务正在运行。" /><section className="rc-link-grid rc-integration-grid"><Link href="/integrations/email"><StatusBadge value={email.data?.configured ? "configured" : email.loading ? "loading" : "unconfigured"} /><small>Resend 邮件 · {email.data?.apiKeyPresent ? "密钥存在" : "密钥缺失"}</small></Link><Link href="/integrations/payments"><b>{payments.data?.providers.length ?? "—"}</b><small>支付配置只读 · Beta 始终禁用</small></Link>{canViewDemo && <Link href="/integrations/demo-exchanges"><StatusBadge value="safe view" /><small>Demo 现货账户、验证与停控</small></Link>}</section>{(email.error || payments.error) && <div className="rc-inline-error" role="alert">{email.error || payments.error}</div>}</>;
}
