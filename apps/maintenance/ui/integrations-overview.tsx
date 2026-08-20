"use client";

import Link from "next/link";

import type { MaintenanceEmailStatus, MaintenancePaymentProvider } from "@/packages/contracts/src/riverton-ui";
import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

export function IntegrationsOverview() {
  const email = useApiData<MaintenanceEmailStatus>("/api/maintenance/email/status", "邮件状态读取失败");
  const payments = useApiData<{ providers: MaintenancePaymentProvider[] }>("/api/maintenance/payment-providers", "支付状态读取失败");
  return <><PageHeading eyebrow="INTEGRATIONS" title="服务集成" description="安全查看邮件与支付配置状态；配置存在不等于服务正在运行。" /><section className="rc-link-grid rc-integration-grid"><Link href="/integrations/email"><StatusBadge value={email.data?.configured ? "configured" : email.loading ? "loading" : "unconfigured"} /><small>Resend 邮件 · {email.data?.apiKeyPresent ? "密钥存在" : "密钥缺失"}</small></Link><Link href="/integrations/payments"><b>{payments.data?.providers.length ?? "—"}</b><small>支付配置 · {payments.data?.providers.filter((provider) => provider.status === "active").length ?? "—"} 个 active</small></Link></section>{(email.error || payments.error) && <div className="rc-inline-error" role="alert">{email.error || payments.error}</div>}</>;
}
