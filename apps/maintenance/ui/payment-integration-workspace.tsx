"use client";

import {
  formatDateTime,
  type MaintenancePaymentProvider,
} from "@/packages/contracts/src/riverton-ui";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

export function PaymentIntegrationWorkspace({
  canManage,
}: {
  canManage: boolean;
}) {
  const resource = useApiData<{ providers: MaintenancePaymentProvider[] }>(
    "/api/maintenance/payment-providers",
    "支付配置读取失败",
  );
  if (resource.loading && !resource.data) {
    return <LoadingState label="正在读取支付配置…" />;
  }
  if (resource.error && !resource.data) {
    return <ErrorState message={resource.error} retry={resource.refresh} />;
  }
  return (
    <>
      <PageHeading
        eyebrow="PAYMENT INTEGRATION"
        title="支付服务"
        description="商业 Beta 的 Payment Worker 与真实支付始终禁用；此页仅展示安全配置投影。"
        actions={
          <button
            className="rc-button"
            type="button"
            onClick={() => void resource.refresh()}
          >
            刷新状态
          </button>
        }
      />
      <section className="rc-panel">
        <header>
          <div>
            <small>BETA POLICY: DISABLED</small>
            <h2>支付渠道只读状态</h2>
            <p>
              {canManage
                ? "当前账户虽有集成管理权限，但 Beta UI 不提供状态切换或 provider 测试。"
                : "当前账户仅可查看安全状态。"}
            </p>
          </div>
          <StatusBadge value="始终禁用" />
        </header>
        {!resource.data?.providers.length ? (
          <EmptyState
            title="未配置支付服务"
            description="客户端创建充值时会收到明确的 503 原因，不会生成地址或二维码。"
          />
        ) : (
          <div className="rc-card-list">
            {resource.data.providers.map((provider) => (
              <article key={provider.id}>
                <header>
                  <div>
                    <b>{provider.provider}</b>
                    <small>
                      {provider.channel} · {provider.network || "无网络"}
                    </small>
                  </div>
                  <StatusBadge value={provider.effectiveStatus} />
                </header>
                <dl className="rc-description-list">
                  <div>
                    <dt>存储状态</dt>
                    <dd>{provider.configuredStatus}（历史配置，不生效）</dd>
                  </div>
                  <div>
                    <dt>Beta 有效状态</dt>
                    <dd>{provider.effectiveStatus}</dd>
                  </div>
                  <div>
                    <dt>确认阈值</dt>
                    <dd>{provider.confirmationThreshold ?? "未设置"}</dd>
                  </div>
                  <div>
                    <dt>密钥</dt>
                    <dd>
                      {provider.hasSecret ? "已保存（不可回显）" : "未配置"}
                    </dd>
                  </div>
                  <div>
                    <dt>更新时间</dt>
                    <dd>{formatDateTime(provider.updatedAt)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
