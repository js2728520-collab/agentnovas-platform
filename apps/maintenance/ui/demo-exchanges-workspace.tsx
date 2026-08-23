"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type DemoCardView = {
  strategyCode: string;
  killSwitchEnabled: boolean;
  updatedAt: string | null;
};

type DemoAccountView = {
  id: string;
  provider: string;
  label: string;
  configured: boolean;
  hasApiKey: boolean;
  hasSecret: boolean;
  hasPassphrase: boolean;
  enabled: boolean;
  killSwitchEnabled: boolean;
  lastVerifiedAt: string | null;
  lastVerificationStatus: string | null;
  verificationFresh: boolean;
  updatedAt: string;
  dailyNotional: string;
  dailyIntentCount: number;
  latestReceipt: {
    status: string;
    filledQuoteUsdt: string;
    feeUsdt: string | null;
    observedAt: string;
  } | null;
  cards: DemoCardView[];
};

type DemoSafeView = {
  checkedAt: string;
  executionPolicy: {
    quoteAmountUsdt: string;
    providerDailyCapUsdt: string;
    livePerpetualOrders: false;
  };
  accounts: DemoAccountView[];
};

type PendingAction = {
  idempotencyKey: string;
  account: DemoAccountView;
  action:
    | "verify"
    | "enable"
    | "disable"
    | "kill"
    | "resume"
    | "card_kill"
    | "card_resume";
  strategyCode?: string;
};

const strategyLabels: Record<string, string> = {
  ai_conservative: "AI 稳健卡",
  ai_balanced: "AI 平衡卡",
  ai_aggressive: "AI 进取卡",
};

export function DemoExchangesWorkspace({
  canVerify,
  canManage,
  canKill,
}: {
  canVerify: boolean;
  canManage: boolean;
  canKill: boolean;
}) {
  const resource = useApiData<DemoSafeView>(
    "/api/maintenance/demo-exchanges",
    "Demo 账户安全视图读取失败",
  );
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [verifyReason, setVerifyReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function queueAction(action: Omit<PendingAction, "idempotencyKey">) {
    setPending({ ...action, idempotencyKey: crypto.randomUUID() });
  }

  async function execute(actionToRun: PendingAction, reason: string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const suffix = actionToRun.action === "verify" ? "verify" : "control";
      const response = await fetch(
        `/api/maintenance/demo-exchanges/${encodeURIComponent(actionToRun.account.id)}/${suffix}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": actionToRun.idempotencyKey,
          },
          body: JSON.stringify({
            reason,
            ...(actionToRun.action === "verify" ? {} : { action: actionToRun.action }),
            ...(actionToRun.strategyCode
              ? { strategyCode: actionToRun.strategyCode }
              : {}),
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.replace(`/login?next=${encodeURIComponent(next)}`);
        throw new Error("会话已过期，正在返回登录页");
      }
      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, "Demo 账户操作失败"));
      }
      const noChange =
        payload &&
        typeof payload === "object" &&
        "result" in payload &&
        payload.result === "NO_CHANGE";
      setMessage(
        noChange
          ? "状态未变化；未新增安全控制变更。"
          : actionToRun.action === "verify"
          ? "Demo provider 验证已真实执行并返回通过；这不表示 Worker 已启用或外部写入已授权。"
          : "安全控制已记录；页面刷新后展示数据库真状态，不表示发生了任何真实订单。",
      );
      if (actionToRun.action !== "verify") setPending(null);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Demo 账户操作失败");
    } finally {
      setBusy(false);
    }
  }

  function verifyAccount(account: DemoAccountView) {
    void execute({ account, action: "verify", idempotencyKey: crypto.randomUUID() }, verifyReason.trim());
  }

  if (resource.loading && !resource.data) {
    return <LoadingState label="正在读取 Demo 账户安全视图…" />;
  }
  if (resource.error && !resource.data) {
    return <ErrorState message={resource.error} retry={resource.refresh} />;
  }
  const policy = resource.data?.executionPolicy;
  return (
    <>
      <PageHeading
        eyebrow="DEMO SPOT CONTROL"
        title="平台 Demo 交易所"
        description="平台测试账户，不代表客户真实成交。仅允许 Demo 现货、固定 10 USDT 意图；永续真实订单始终禁用。"
        actions={
          <button
            className="rc-button"
            type="button"
            onClick={() => void resource.refresh()}
          >
            刷新安全视图
          </button>
        }
      />
      <div className="rc-live" aria-live="polite">
        {message}
      </div>
      <section className="rc-kpi-grid" aria-label="Demo 执行硬限制">
        <article>
          <small>单次名义金额</small>
          <strong>{policy?.quoteAmountUsdt ?? "—"} USDT</strong>
          <span>服务端与数据库固定</span>
        </article>
        <article>
          <small>Provider 日上限</small>
          <strong>{policy?.providerDailyCapUsdt ?? "—"} USDT</strong>
          <span>按 UTC 日累计</span>
        </article>
        <article>
          <small>永续真实订单</small>
          <strong className="rc-kpi-status">始终禁用</strong>
          <span>不提供任何 UI 入口</span>
        </article>
      </section>
      {canVerify ? <section className="rc-panel"><header><div><small>CONNECTION AUDIT</small><h2>Demo 连接验证</h2><p>填写一次原因后可直接验证账户连接；账户启停和紧急控制仍保留独立确认。</p></div></header><div className="rc-form"><InlineAuditReasonField id="demo-verification-reason" value={verifyReason} onChange={setVerifyReason} minLength={8} label="连接验证原因" /></div></section> : null}
      {!resource.data?.accounts.length ? (
        <EmptyState
          title="尚无平台 Demo 账户"
          description="未配置时不会生成假账户、假验证或假成交回执。"
        />
      ) : (
        <div className="rc-card-list">
          {resource.data.accounts.map((account) => (
            <section className="rc-panel" key={account.id}>
              <header>
                <div>
                  <small>{account.provider.toUpperCase()} DEMO SPOT</small>
                  <h2>{account.label}</h2>
                  <p>账户 ID {account.id}</p>
                </div>
                <StatusBadge
                  value={
                    account.killSwitchEnabled
                      ? "KILLED"
                      : account.enabled
                        ? "ENABLED"
                        : "DISABLED"
                  }
                />
              </header>
              <div className="rc-health-grid">
                <article>
                  <span>配置</span>
                  <StatusBadge
                    value={account.configured ? "configured" : "unconfigured"}
                  />
                  <small>
                    Key {account.hasApiKey ? "存在" : "缺失"} · Secret {account.hasSecret ? "存在" : "缺失"}
                    {account.hasPassphrase ? " · Passphrase 存在" : ""}
                  </small>
                </article>
                <article>
                  <span>最近验证</span>
                  <StatusBadge
                    value={account.lastVerificationStatus ?? "not_verified"}
                  />
                  <small>
                    {account.lastVerifiedAt
                      ? formatDateTime(account.lastVerifiedAt)
                      : "从未验证"}
                    {account.verificationFresh ? " · 15 分钟内有效" : " · 已过期或未通过"}
                  </small>
                </article>
                <article>
                  <span>今日意图</span>
                  <b>{formatDecimal(account.dailyNotional)} USDT</b>
                  <small>{account.dailyIntentCount} 个 · 非成交额</small>
                </article>
                <article>
                  <span>最近不可变回执</span>
                  <StatusBadge
                    value={account.latestReceipt?.status ?? "none"}
                  />
                  <small>
                    {account.latestReceipt
                      ? `${formatDecimal(account.latestReceipt.filledQuoteUsdt)} USDT · ${formatDateTime(account.latestReceipt.observedAt)}`
                      : "暂无回执"}
                  </small>
                </article>
              </div>
              <div className="rc-action-row">
                {canVerify && (
                  <button
                    className="rc-button"
                    type="button"
                    disabled={busy || !hasValidAuditReason(verifyReason, 8)}
                    onClick={() => verifyAccount(account)}
                  >
                    验证 Demo 连接
                  </button>
                )}
                {canManage && !account.enabled && !account.killSwitchEnabled && (
                  <button
                    className="rc-button"
                    type="button"
                    disabled={!account.configured || !account.verificationFresh}
                    onClick={() => queueAction({ account, action: "enable" })}
                  >
                    启用账户
                  </button>
                )}
                {canKill && account.enabled && (
                  <button
                    className="rc-button"
                    type="button"
                    onClick={() => queueAction({ account, action: "disable" })}
                  >
                    停用账户
                  </button>
                )}
                {canKill && !account.killSwitchEnabled && (
                  <button
                    className="rc-button rc-danger-button"
                    type="button"
                    onClick={() => queueAction({ account, action: "kill" })}
                  >
                    紧急 Kill
                  </button>
                )}
                {canManage && account.killSwitchEnabled && (
                  <button
                    className="rc-button"
                    type="button"
                    onClick={() => queueAction({ account, action: "resume" })}
                  >
                    解除 Kill（保持停用）
                  </button>
                )}
              </div>
              <div className="rc-card-list">
                {account.cards.map((card) => (
                  <article key={card.strategyCode}>
                    <header>
                      <div>
                        <b>{strategyLabels[card.strategyCode] ?? card.strategyCode}</b>
                        <small>
                          {card.updatedAt
                            ? `最近控制 ${formatDateTime(card.updatedAt)}`
                            : "使用默认未停控状态"}
                        </small>
                      </div>
                      <StatusBadge
                        value={card.killSwitchEnabled ? "KILLED" : "READY"}
                      />
                    </header>
                    <div className="rc-action-row rc-card-actions">
                      {canKill && !card.killSwitchEnabled && (
                        <button
                          className="rc-button rc-danger-button"
                          type="button"
                          onClick={() =>
                            queueAction({
                              account,
                              action: "card_kill",
                              strategyCode: card.strategyCode,
                            })
                          }
                        >
                          停止该卡
                        </button>
                      )}
                      {canManage && card.killSwitchEnabled && (
                        <button
                          className="rc-button"
                          type="button"
                          onClick={() =>
                            queueAction({
                              account,
                              action: "card_resume",
                              strategyCode: card.strategyCode,
                            })
                          }
                        >
                          恢复该卡
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <ConfirmActionDialog
        open={Boolean(pending)}
        title={actionTitle(pending)}
        description={actionDescription(pending)}
        confirmLabel="确认并记录"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={(reason) => { if (pending) void execute(pending, reason); }}
      />
    </>
  );
}

function actionTitle(pending: PendingAction | null) {
  if (!pending) return "Demo 安全操作";
  if (pending.action === "verify") return "验证 Demo provider 连接";
  if (pending.action === "kill" || pending.action === "card_kill") {
    return "执行 Demo 紧急停控";
  }
  return "变更 Demo 安全控制";
}

function actionDescription(pending: PendingAction | null) {
  if (pending?.action === "verify") {
    return "只有环境显式授权时才会请求 Demo provider；未授权会返回 503，不会显示假成功。";
  }
  if (pending?.action === "enable") {
    return "启用要求密钥完整且 15 分钟内验证通过；仍需 Worker 和外部写入开关同时开启才可能发送 Demo 现货订单。";
  }
  return "控制只更新平台 Demo 账户或策略卡停控状态；不会创建、撤销或声称执行任何订单。";
}
