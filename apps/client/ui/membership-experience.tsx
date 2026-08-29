"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CommercialLegalDocument, CommercialPlan, CursorPage, MembershipEntitlement, MembershipOrder } from "@/packages/contracts/src/commercial-beta";
import { clientErrorMessage, clientRequest, newIdempotencyKey } from "./client-api";
import { legalDocumentLabel, membershipPlanLabel } from "./client-account-presentation";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import styles from "./membership-experience.module.css";

type MembershipData = {
  plans: CommercialPlan[];
  legalDocuments: CommercialLegalDocument[];
  orderCreationAvailable: boolean;
  membership: MembershipEntitlement | null;
  orders: MembershipOrder[];
};
const statusLabels: Record<string, string> = {
  AWAITING_EVIDENCE: "等待提交付款凭证", SUBMITTED: "凭证已提交，等待人工审核", REJECTED: "审核未通过",
  ACTIVATED: "会员已激活", CANCELLED: "申请已取消", TRIAL: "试用中", ACTIVE: "生效中", GRACE: "宽限期",
  READ_ONLY: "只读", EXPIRED: "已到期",
};
function formatDate(value: string | null, locale: string, translate: (text: string) => string) {
  if (!value) return translate("长期有效");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
const planPeriod = (plan: CommercialPlan, translate: (text: string) => string) => plan.isLifetime
  ? translate("长期会员")
  : `${plan.durationDays ?? "—"} ${translate("天")}`;

export default function MembershipExperience({ canCreateOrder = true }: { canCreateOrder?: boolean }) {
  const { locale, t } = useAppLocale();
  const [data, setData] = useState<MembershipData | null>(null);
  const [selectedCode, setSelectedCode] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [paying, setPaying] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [busy, setBusy] = useState(false);
  const acknowledgementId = useId();
  const resultRef = useRef<HTMLDivElement>(null);
  const orderIdempotencyKey = useRef(newIdempotencyKey());

  const load = useCallback(async () => {
    setState("loading"); setMessage(""); setMessageKind("success");
    try {
      const [planPayload, membershipPayload, orderPayload] = await Promise.all([
        clientRequest<{ plans: CommercialPlan[]; requiredLegalDocuments: CommercialLegalDocument[]; orderCreationAvailable: boolean }>("/api/membership/plans", {}, t("会员计划读取失败")),
        clientRequest<{ membership: MembershipEntitlement | null }>("/api/membership/me", {}, t("会员状态读取失败")),
        clientRequest<CursorPage<MembershipOrder>>("/api/membership/orders?limit=20", {}, t("会员申请读取失败")),
      ]);
      const nextData: MembershipData = {
        plans: planPayload.plans, legalDocuments: planPayload.requiredLegalDocuments,
        orderCreationAvailable: planPayload.orderCreationAvailable, membership: membershipPayload.membership,
        orders: orderPayload.data,
      };
      setData(nextData); setSelectedCode((current) => current || nextData.plans[0]?.code || ""); setState("ready");
    } catch (error) { setMessage(clientErrorMessage(error, t("会员中心读取失败"))); setState("error"); }
  }, [t]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function createOrder() {
    if (!data || busy || !selectedCode || !acknowledged || !canCreateOrder) return;
    setBusy(true); setMessage(""); setMessageKind("success");
    try {
      const result = await clientRequest<{ order: MembershipOrder }>("/api/membership/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": orderIdempotencyKey.current },
        body: JSON.stringify({ planCode: selectedCode, acceptedDocumentVersionIds: data.legalDocuments.map((document) => document.id) }),
      }, t("会员申请创建失败"));
      setData((current) => current ? { ...current, orders: [result.order, ...current.orders.filter((order) => order.id !== result.order.id)] } : current);
      setAcknowledged(false);
      orderIdempotencyKey.current = newIdempotencyKey();
      setMessage(result.order.paymentInstructionsStatus === "UNAVAILABLE"
        ? t("申请已记录。当前未提供线上付款指引，请等待团队通过正式渠道联系；系统未生成收款地址，也未完成扣款。")
        : t("申请已记录，请按订单中由服务端提供的正式付款指引继续。")
      );
      setMessageKind("success");
    } catch (error) { setMessageKind("error"); setMessage(clientErrorMessage(error, t("会员申请创建失败"))); }
    finally { setBusy(false); window.requestAnimationFrame(() => resultRef.current?.focus()); }
  }

  if (state === "loading") return <div className={styles.root} aria-busy="true" aria-label={t("会员中心加载中")}><div className={styles.skeleton} /><div className={styles.skeleton} /></div>;
  if (state === "error" || !data) return <div className={styles.root}><section className={styles.panel}><h1>{t("会员中心暂不可用")}</h1><p className={styles.error} role="alert">{message}</p><button className={styles.secondary} type="button" onClick={() => void load()}>{t("重试")}</button></section></div>;
  const selectedPlan = data.plans.find((plan) => plan.code === selectedCode) ?? null;

  async function payFromWallet(orderId: string) {
    if (paying) return;
    setPaying(orderId);
    setMessage("");
    try {
      const response = await fetch(`/api/membership/orders/${orderId}/pay-from-wallet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 幂等键在客户端生成：支付路径上网络重试是常态，
        // 没有它同一次点击可能扣两次。
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        // 余额不足是可操作的结果，不是错误——直接告诉客户去充值。
        throw new Error(payload.code === "WALLET_BALANCE_INSUFFICIENT"
          ? t("钱包余额不足，请先到「钱包」充值后再支付。")
          : String(payload.error ?? t("支付失败")));
      }
      setMessage(String(payload.message ?? t("会员已开通")));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("支付失败"));
    } finally {
      setPaying(null);
    }
  }

  return <div className={styles.root}>
    <header className={styles.hero}><div><span className={styles.eyebrow}>{t("账户权益")}</span><h1>{t("会员")}</h1><p>{t("查看当前权益、选择会员计划并跟踪申请状态。")}</p></div></header>
    {data.membership && <section className={styles.panel} aria-labelledby="membership-status-title"><div className={styles.panelHead}><div><h2 id="membership-status-title">{t("当前会员")}</h2></div><span className={styles.badge}>{t(statusLabels[data.membership.status] ?? "状态更新中")}</span></div><dl className={styles.summaryGrid}><div><dt>{t("计划")}</dt><dd>{t(membershipPlanLabel(data.membership.planCode))}</dd></div><div><dt>{t("开始时间")}</dt><dd>{formatDate(data.membership.startsAt, locale, t)}</dd></div><div><dt>{t("有效期至")}</dt><dd>{formatDate(data.membership.expiresAt, locale, t)}{data.membership.closeOnly ? ` · ${t("仅可管理现有持仓")}` : ""}</dd></div></dl></section>}
    <section className={styles.panel} aria-labelledby="membership-plans-title"><div className={styles.panelHead}><div><h2 id="membership-plans-title">{t("选择会员计划")}</h2></div><span className={styles.badge}>{data.plans.length} {t("个计划")}</span></div>{data.plans.length === 0 ? <p className={styles.notice}>{t("当前没有可申请的会员计划。")}</p> : <div className={styles.plans}>{data.plans.map((plan) => <button key={`${plan.code}-${plan.version}`} type="button" className={`${styles.plan} ${selectedCode === plan.code ? styles.selected : ""}`} aria-pressed={selectedCode === plan.code} onClick={() => { setSelectedCode(plan.code); setAcknowledged(false); orderIdempotencyKey.current = newIdempotencyKey(); }}><span className={styles.planName}>{t(membershipPlanLabel(plan.code))}</span><strong>{plan.priceUsd} {plan.priceCurrency}</strong><p>{planPeriod(plan, t)}</p><small>{t("包含")} {plan.aiCredits.toLocaleString(locale)} {t("AI 积分")}</small><small>{t("模拟绩效服务费率")} {(Number(plan.performanceFeeRate) * 100).toFixed(0)}%</small></button>)}</div>}</section>
    <section className={styles.panel} id="membership-payment" aria-labelledby="membership-application-title"><div className={styles.panelHead}><div><h2 id="membership-application-title">{t("确认并申请")}</h2></div>{selectedPlan && <span className={styles.badge}>{t(membershipPlanLabel(selectedPlan.code))}</span>}</div><p className={styles.muted}>{t("提交前请逐项阅读本次计划对应的服务说明。申请提交后仍需完成支付和审核。")}</p><div className={styles.legalList} aria-label={t("本次申请的服务说明")}>{data.legalDocuments.map((document) => <article className={styles.legalItem} key={document.id}><details><summary><strong>{t(legalDocumentLabel(document.type))}</strong><span>{t("版本")} {document.version} · {t("生效")} {formatDate(document.effectiveAt, locale, t)}</span></summary>{document.contentMarkdown ? <div className={styles.notice}>{document.contentMarkdown}</div> : <p role="alert">{t("当前说明正文暂不可用。")}</p>}</details></article>)}</div>{!data.orderCreationAvailable && <p className={styles.error} role="alert">{t("会员服务说明尚未完整发布，暂时无法提交申请。")}</p>}{!canCreateOrder && <p className={styles.error} role="alert">{t("当前账号只能查看会员计划和申请记录。")}</p>}<label className={styles.acknowledgement} htmlFor={acknowledgementId}><input id={acknowledgementId} type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={!data.orderCreationAvailable || !canCreateOrder} /><span>{t("我已阅读并同意以上服务说明，了解提交申请不代表付款成功或会员已开通。")}</span></label><button className={styles.primary} type="button" disabled={busy || !selectedPlan || !acknowledged || !data.orderCreationAvailable || !canCreateOrder} onClick={() => void createOrder()}>{busy ? t("正在提交…") : t("提交会员申请")}</button>{message && <div ref={resultRef} className={messageKind === "error" ? styles.error : styles.notice} role={messageKind === "error" ? "alert" : "status"} aria-live={messageKind === "error" ? "assertive" : "polite"} tabIndex={-1}>{message}</div>}</section>
    <section className={styles.panel} aria-labelledby="membership-orders-title"><div className={styles.panelHead}><div><h2 id="membership-orders-title">{t("申请记录")}</h2></div><span className={styles.badge}>{data.orders.length} {t("笔")}</span></div>{data.orders.length === 0 ? <p className={styles.notice}>{t("暂无会员申请。")}</p> : <div className={styles.orders}>{data.orders.map((order) => <article className={styles.order} key={order.id}><div><strong>{t(membershipPlanLabel(order.plan.code))}</strong><p>{order.plan.priceUsd} {order.plan.priceCurrency} · {formatDate(order.createdAt, locale, t)}</p></div><span className={styles.badge}>{t(statusLabels[order.status] ?? "状态更新中")}</span>
      {order.status === "AWAITING_EVIDENCE" ? (
        <button
          type="button"
          className={styles.walletPay}
          disabled={paying === order.id}
          onClick={() => void payFromWallet(order.id)}
        >
          {paying === order.id ? t("扣款中…") : `${t("用余额支付")} ${order.plan.priceUsd} ${order.plan.priceCurrency}`}
        </button>
      ) : null}
    </article>)}</div>}</section>
  </div>;
}
