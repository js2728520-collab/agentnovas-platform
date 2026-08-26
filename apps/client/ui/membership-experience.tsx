"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AiCreditBalance, CommercialLegalDocument, CommercialPlan, CursorPage, MembershipEntitlement, MembershipOrder } from "@/packages/contracts/src/commercial-beta";
import { clientErrorMessage, clientRequest, newIdempotencyKey } from "./client-api";
import styles from "./membership-experience.module.css";

type MembershipData = {
  plans: CommercialPlan[];
  legalDocuments: CommercialLegalDocument[];
  orderCreationAvailable: boolean;
  membership: MembershipEntitlement | null;
  orders: MembershipOrder[];
  credits: AiCreditBalance | null;
  creditError: string;
};
const statusLabels: Record<string, string> = {
  AWAITING_EVIDENCE: "等待提交付款凭证", SUBMITTED: "凭证已提交，等待人工审核", REJECTED: "审核未通过",
  ACTIVATED: "会员已激活", CANCELLED: "申请已取消", TRIAL: "试用中", ACTIVE: "生效中", GRACE: "宽限期",
  READ_ONLY: "只读", EXPIRED: "已到期",
};
function formatDate(value: string | null) {
  if (!value) return "长期有效";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
const planPeriod = (plan: CommercialPlan) => plan.isLifetime ? "长期会员" : `${plan.durationDays ?? "—"} 天`;

export default function MembershipExperience({ canCreateOrder = true }: { canCreateOrder?: boolean }) {
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
        clientRequest<{ plans: CommercialPlan[]; requiredLegalDocuments: CommercialLegalDocument[]; orderCreationAvailable: boolean }>("/api/membership/plans", {}, "会员计划读取失败"),
        clientRequest<{ membership: MembershipEntitlement | null }>("/api/membership/me", {}, "会员状态读取失败"),
        clientRequest<CursorPage<MembershipOrder>>("/api/membership/orders?limit=20", {}, "会员申请读取失败"),
      ]);
      let credits: AiCreditBalance | null = null;
      let creditError = "";
      try { credits = (await clientRequest<{ credits: AiCreditBalance }>("/api/credits/me", {}, "积分余额读取失败")).credits; }
      catch (error) { creditError = clientErrorMessage(error, "积分余额读取失败"); }
      const nextData: MembershipData = {
        plans: planPayload.plans, legalDocuments: planPayload.requiredLegalDocuments,
        orderCreationAvailable: planPayload.orderCreationAvailable, membership: membershipPayload.membership,
        orders: orderPayload.data, credits, creditError,
      };
      setData(nextData); setSelectedCode((current) => current || nextData.plans[0]?.code || ""); setState("ready");
    } catch (error) { setMessage(clientErrorMessage(error, "会员中心读取失败")); setState("error"); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function createOrder() {
    if (!data || busy || !selectedCode || !acknowledged || !canCreateOrder) return;
    setBusy(true); setMessage(""); setMessageKind("success");
    try {
      const result = await clientRequest<{ order: MembershipOrder }>("/api/membership/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": orderIdempotencyKey.current },
        body: JSON.stringify({ planCode: selectedCode, acceptedDocumentVersionIds: data.legalDocuments.map((document) => document.id) }),
      }, "会员申请创建失败");
      setData((current) => current ? { ...current, orders: [result.order, ...current.orders.filter((order) => order.id !== result.order.id)] } : current);
      setAcknowledged(false);
      orderIdempotencyKey.current = newIdempotencyKey();
      setMessage(result.order.paymentInstructionsStatus === "UNAVAILABLE"
        ? "申请已记录。当前未提供线上付款指引，请等待团队通过正式渠道联系；系统未生成收款地址，也未完成扣款。"
        : "申请已记录，请按订单中由服务端提供的正式付款指引继续。"
      );
      setMessageKind("success");
    } catch (error) { setMessageKind("error"); setMessage(clientErrorMessage(error, "会员申请创建失败")); }
    finally { setBusy(false); window.requestAnimationFrame(() => resultRef.current?.focus()); }
  }

  if (state === "loading") return <div className={styles.root} aria-busy="true" aria-label="会员中心加载中"><div className={styles.skeleton} /><div className={styles.skeleton} /></div>;
  if (state === "error" || !data) return <div className={styles.root}><section className={styles.panel}><h1>会员中心暂不可用</h1><p className={styles.error} role="alert">{message}</p><button className={styles.secondary} type="button" onClick={() => void load()}>重试</button></section></div>;
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
          ? "钱包余额不足，请先到「钱包」充值后再支付。"
          : String(payload.error ?? "支付失败"));
      }
      setMessage(String(payload.message ?? "会员已开通"));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "支付失败");
    } finally {
      setPaying(null);
    }
  }

  return <div className={styles.root}>
    <header className={styles.hero}><div><span className={styles.eyebrow}>CLIENT MEMBERSHIP</span><h1>会员与 AI 积分</h1><p>价格、权益、积分与申请状态均来自当前商业合同；付款和开通由人工审核闭环完成。</p></div><div className={styles.balance} role="group" aria-label="AI 积分余额">{data.credits ? <><span>可用积分</span><strong>{data.credits.available}</strong><small>冻结 {data.credits.reserved} · 账本版本 {data.credits.version}</small></> : <><span>积分服务暂不可用</span><strong>—</strong><small>{data.creditError}</small></>}</div></header>
    {data.membership && <section className={styles.panel} aria-labelledby="membership-status-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>CURRENT ACCESS</span><h2 id="membership-status-title">当前会员</h2></div><span className={styles.badge}>{statusLabels[data.membership.status] ?? data.membership.status}</span></div><dl className={styles.summaryGrid}><div><dt>计划</dt><dd>{data.membership.planCode}</dd></div><div><dt>开始时间</dt><dd>{formatDate(data.membership.startsAt)}</dd></div><div><dt>到期边界</dt><dd>{formatDate(data.membership.expiresAt)}{data.membership.closeOnly ? " · 仅平仓/只读" : ""}</dd></div></dl></section>}
    <section className={styles.panel} aria-labelledby="membership-plans-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>SERVER PLANS</span><h2 id="membership-plans-title">选择会员计划</h2></div><span className={styles.badge}>{data.plans.length} 个可用计划</span></div>{data.plans.length === 0 ? <p className={styles.notice}>当前没有可申请的会员计划。</p> : <div className={styles.plans}>{data.plans.map((plan) => <button key={`${plan.code}-${plan.version}`} type="button" className={`${styles.plan} ${selectedCode === plan.code ? styles.selected : ""}`} aria-pressed={selectedCode === plan.code} onClick={() => { setSelectedCode(plan.code); setAcknowledged(false); orderIdempotencyKey.current = newIdempotencyKey(); }}><span className={styles.planName}>{plan.name}</span><strong>{plan.priceUsd} {plan.priceCurrency}</strong><p>{planPeriod(plan)}</p><small>AI 积分 {plan.aiCredits} · 周盈利分成费率 {plan.performanceFeeRate}</small><small>合同版本 v{plan.version}</small></button>)}</div>}</section>
    <section className={styles.panel} id="membership-payment" aria-labelledby="membership-application-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>APPLICATION</span><h2 id="membership-application-title">提交会员申请</h2></div>{selectedPlan && <span className={styles.badge}>{selectedPlan.name}</span>}</div><p className={styles.muted}>申请只会锁定服务端计划与商业披露快照，不代表付款成功或会员已开通。付款凭证需由 Operations 人工核验并双人审批。</p><div className={styles.legalList} aria-label="本次申请绑定的商业披露正文">{data.legalDocuments.map((document) => <article className={styles.legalItem} key={document.id}><details><summary><strong>{document.type}</strong><span>版本 {document.version} · {document.locale ?? "正文未配置"} · 生效 {formatDate(document.effectiveAt)}</span></summary>{document.contentMarkdown ? <div className={styles.notice}>{document.contentMarkdown}</div> : <p role="alert">当前版本没有可供阅读的已校验正文。</p>}</details><code title={document.contentSha256}>{document.contentSha256}</code></article>)}</div>{!data.orderCreationAvailable && <p className={styles.error} role="alert">七项商业披露尚未全部提供、校验并完成双人复核，当前不能创建付费申请。</p>}{!canCreateOrder && <p className={styles.error} role="alert">当前账号没有提交会员申请的权限，可继续查看计划、权益与历史申请。</p>}<label className={styles.acknowledgement} htmlFor={acknowledgementId}><input id={acknowledgementId} type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={!data.orderCreationAvailable || !canCreateOrder} /><span>我已逐项阅读以上七份正文，并同意本次申请绑定其版本与内容哈希；我理解提交申请不等于付款、激活或资金到账。</span></label><button className={styles.primary} type="button" disabled={busy || !selectedPlan || !acknowledged || !data.orderCreationAvailable || !canCreateOrder} onClick={() => void createOrder()}>{busy ? "正在提交…" : "提交会员申请"}</button>{message && <div ref={resultRef} className={messageKind === "error" ? styles.error : styles.notice} role={messageKind === "error" ? "alert" : "status"} aria-live={messageKind === "error" ? "assertive" : "polite"} tabIndex={-1}>{message}</div>}</section>
    <section className={styles.panel} aria-labelledby="membership-orders-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>ORDER HISTORY</span><h2 id="membership-orders-title">申请记录</h2></div><span className={styles.badge}>{data.orders.length} 笔</span></div>{data.orders.length === 0 ? <p className={styles.notice}>暂无会员申请。提交后可在此追踪付款凭证、审核与激活状态。</p> : <div className={styles.orders}>{data.orders.map((order) => <article className={styles.order} key={order.id}><div><strong>{order.orderNo} · {order.plan.name}</strong><p>{order.plan.priceUsd} {order.plan.priceCurrency} · 创建于 {formatDate(order.createdAt)}</p></div><span className={styles.badge}>{statusLabels[order.status] ?? order.status}</span>
      {order.status === "AWAITING_EVIDENCE" ? (
        <button
          type="button"
          className={styles.walletPay}
          disabled={paying === order.id}
          onClick={() => void payFromWallet(order.id)}
        >
          {paying === order.id ? "扣款中…" : `用余额支付 ${order.plan.priceUsd} ${order.plan.priceCurrency}`}
        </button>
      ) : null}
    </article>)}</div>}</section>
  </div>;
}
