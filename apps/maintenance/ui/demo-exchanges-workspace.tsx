"use client";

import { useRef, useState } from "react";

import { apiErrorMessage, formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

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

type DemoAction = {
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
  const { locale, t } = useAppLocale();
  const resource = useApiData<DemoSafeView>(
    "/api/maintenance/demo-exchanges",
    t("Demo 账户安全视图读取失败"),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controlKeys = useRef(new Map<string, string>());

  async function execute(actionToRun: DemoAction) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const keyName = `${actionToRun.account.id}:${actionToRun.action}:${actionToRun.strategyCode ?? "account"}`;
    const idempotencyKey = actionToRun.action === "verify"
      ? crypto.randomUUID()
      : controlKeys.current.get(keyName) ?? crypto.randomUUID();
    if (actionToRun.action !== "verify") controlKeys.current.set(keyName, idempotencyKey);
    try {
      const suffix = actionToRun.action === "verify" ? "verify" : "control";
      const response = await fetch(
        `/api/maintenance/demo-exchanges/${encodeURIComponent(actionToRun.account.id)}/${suffix}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
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
        throw new Error(t("会话已过期，正在返回登录页"));
      }
      if (!response.ok) {
        const fallback = t("Demo 账户操作失败");
        const detail = apiErrorMessage(payload, fallback);
        throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
      }
      const noChange =
        payload &&
        typeof payload === "object" &&
        "result" in payload &&
        payload.result === "NO_CHANGE";
      setMessage(
        noChange
          ? t("状态未变化；未新增安全控制变更。")
          : actionToRun.action === "verify"
          ? t("Demo provider 验证已真实执行并返回通过；这不表示 Worker 已启用或外部写入已授权。")
          : t("安全控制已记录；页面刷新后展示数据库真状态，不表示发生了任何真实订单。"),
      );
      if (actionToRun.action !== "verify") controlKeys.current.delete(keyName);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Demo 账户操作失败"));
    } finally {
      setBusy(false);
    }
  }

  function verifyAccount(account: DemoAccountView) {
    void execute({ account, action: "verify" });
  }

  if (resource.loading && !resource.data) {
    return <LoadingState label={t("正在读取 Demo 账户安全视图…")} />;
  }
  if (resource.error && !resource.data) {
    return <ErrorState message={resource.error} retry={resource.refresh} />;
  }
  const policy = resource.data?.executionPolicy;
  return (
    <>
      <PageHeading
        eyebrow="DEMO SPOT CONTROL"
        title={t("平台 Demo 交易所")}
        description={t("平台测试账户，不代表客户真实成交。仅允许 Demo 现货、固定 10 USDT 意图；永续真实订单始终禁用。")}
        actions={
          <button
            className="rc-button"
            type="button"
            onClick={() => void resource.refresh()}
          >
            {t("刷新安全视图")}
          </button>
        }
      />
      <div className="rc-live" aria-live="polite">
        {message}
      </div>
      <section className="rc-kpi-grid" aria-label={t("Demo 执行硬限制")}>
        <article>
          <small>{t("单次名义金额")}</small>
          <strong>{policy?.quoteAmountUsdt ?? "—"} USDT</strong>
          <span>{t("服务端与数据库固定")}</span>
        </article>
        <article>
          <small>{t("Provider 日上限")}</small>
          <strong>{policy?.providerDailyCapUsdt ?? "—"} USDT</strong>
          <span>{t("按 UTC 日累计")}</span>
        </article>
        <article>
          <small>{t("永续真实订单")}</small>
          <strong className="rc-kpi-status">{t("始终禁用")}</strong>
          <span>{t("不提供任何 UI 入口")}</span>
        </article>
      </section>
      {!resource.data?.accounts.length ? (
        <EmptyState
          title={t("尚无平台 Demo 账户")}
          description={t("未配置时不会生成假账户、假验证或假成交回执。")}
        />
      ) : (
        <div className="rc-card-list">
          {resource.data.accounts.map((account) => (
            <section className="rc-panel" key={account.id}>
              <header>
                <div>
                  <small>{account.provider.toUpperCase()} DEMO SPOT</small>
                  <h2>{account.label}</h2>
                  <p>{t("账户 ID")} {account.id}</p>
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
                  <span>{t("配置")}</span>
                  <StatusBadge
                    value={account.configured ? "configured" : "unconfigured"}
                  />
                  <small>
                    Key {account.hasApiKey ? t("存在") : t("缺失")} · Secret {account.hasSecret ? t("存在") : t("缺失")}
                    {account.hasPassphrase ? ` · Passphrase ${t("存在")}` : ""}
                  </small>
                </article>
                <article>
                  <span>{t("最近验证")}</span>
                  <StatusBadge
                    value={account.lastVerificationStatus ?? "not_verified"}
                  />
                  <small>
                    {account.lastVerifiedAt
                      ? formatDateTime(account.lastVerifiedAt, locale)
                      : t("从未验证")}
                    {account.verificationFresh ? ` · ${t("15 分钟内有效")}` : ` · ${t("已过期或未通过")}`}
                  </small>
                </article>
                <article>
                  <span>{t("今日意图")}</span>
                  <b>{formatDecimal(account.dailyNotional)} USDT</b>
                  <small>{account.dailyIntentCount} {t("个 · 非成交额")}</small>
                </article>
                <article>
                  <span>{t("最近不可变回执")}</span>
                  <StatusBadge
                    value={account.latestReceipt?.status ?? "none"}
                  />
                  <small>
                    {account.latestReceipt
                      ? `${formatDecimal(account.latestReceipt.filledQuoteUsdt)} USDT · ${formatDateTime(account.latestReceipt.observedAt, locale)}`
                      : t("暂无回执")}
                  </small>
                </article>
              </div>
              <div className="rc-action-row">
                {canVerify && (
                  <button
                    className="rc-button"
                    type="button"
                    disabled={busy}
                    onClick={() => verifyAccount(account)}
                  >
                    {t("验证 Demo 连接")}
                  </button>
                )}
                {canManage && !account.enabled && !account.killSwitchEnabled && (
                  <button
                    className="rc-button"
                    type="button"
                    disabled={busy || !account.configured || !account.verificationFresh}
                    onClick={() => void execute({ account, action: "enable" })}
                  >
                    {t("启用账户")}
                  </button>
                )}
                {canKill && account.enabled && (
                  <button
                    className="rc-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void execute({ account, action: "disable" })}
                  >
                    {t("停用账户")}
                  </button>
                )}
                {canKill && !account.killSwitchEnabled && (
                  <button
                    className="rc-button rc-danger-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void execute({ account, action: "kill" })}
                  >
                    {t("紧急 Kill")}
                  </button>
                )}
                {canManage && account.killSwitchEnabled && (
                  <button
                    className="rc-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void execute({ account, action: "resume" })}
                  >
                    {t("解除 Kill（保持停用）")}
                  </button>
                )}
              </div>
              <div className="rc-card-list">
                {account.cards.map((card) => (
                  <article key={card.strategyCode}>
                    <header>
                      <div>
                        <b>{t(strategyLabels[card.strategyCode] ?? card.strategyCode)}</b>
                        <small>
                          {card.updatedAt
                            ? `${t("最近控制")} ${formatDateTime(card.updatedAt, locale)}`
                            : t("使用默认未停控状态")}
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
                          disabled={busy}
                          onClick={() => void execute({
                              account,
                              action: "card_kill",
                              strategyCode: card.strategyCode,
                            })}
                        >
                          {t("停止该卡")}
                        </button>
                      )}
                      {canManage && card.killSwitchEnabled && (
                        <button
                          className="rc-button"
                          type="button"
                          disabled={busy}
                          onClick={() => void execute({
                              account,
                              action: "card_resume",
                              strategyCode: card.strategyCode,
                            })}
                        >
                          {t("恢复该卡")}
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
    </>
  );
}
