"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";

import type { SystemSettings } from "@/lib/platform-settings-contract";
import { requiredLegalDocumentTypes } from "@/packages/domain/src/commercial-membership-domain";
import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type DisclosureDocument = { type: string; contentMarkdown: string; contentSha256: string };
type DisclosureRequest = {
  id: string;
  locale: string;
  productIdentity: { operatorName: string; serviceRegion: string; supportEmail: string; primaryDomain: string };
  documents: DisclosureDocument[];
  snapshotSha256: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  submittedByUserId: string;
  submissionReason: string;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
};
type DisclosureControl = {
  activeBundle: null | {
    id: string;
    version: string;
    locale: string;
    productIdentity: DisclosureRequest["productIdentity"];
    documents: DisclosureDocument[];
    snapshotSha256: string;
    publishedAt: string;
  };
  requests: DisclosureRequest[];
  readiness: { activeBundlePublished: boolean; documentCount: number; productIdentityComplete: boolean };
};

const labels: Record<string, string> = {
  service_entity: "服务运营方说明",
  jurisdiction: "服务区域与访问限制",
  privacy: "隐私与数据使用说明",
  terms: "服务条款",
  risk_disclosure: "Paper 模拟风险披露",
  simulated_performance_fee_opinion: "模拟收益服务费说明",
  refund_policy: "退款与取消规则",
};

function defaultDocuments(settings: SystemSettings) {
  const operator = settings.serviceOperatorName || "[待配置服务运营方]";
  const region = settings.serviceRegion || "[待配置服务区域]";
  const support = settings.supportEmail || "[待配置客服邮箱]";
  return {
    service_entity: `# 服务运营方说明\n\n本 Paper SaaS 由 ${operator} 运营，公开服务域名为 ${settings.primaryDomain}，客户支持联系方式为 ${support}。本服务不托管客户交易本金。`,
    jurisdiction: `# 服务区域与访问限制\n\n当前服务区域为：${region}。平台仅向受邀并完成版本确认的客户开放；客户应自行确认其所在地允许使用本类模拟研究服务。`,
    privacy: `# 隐私与数据使用说明\n\n平台仅为身份、权限、Paper 组合、会员、通知与审计目的处理必要数据。密钥、密码和完整敏感字段不会在浏览器、日志或商业披露中回显。`,
    terms: "# 服务条款\n\n本产品提供策略研究、七阶段决策证据和 Paper 模拟结果。客户不得把模拟结果当作真实成交、收益承诺或托管资产证明；账户和权限不得转让。",
    risk_disclosure: "# Paper 模拟风险披露\n\nPaper 成交基于确定性模拟撮合与行情快照，可能与真实市场的流动性、滑点、延迟和成交结果不同。历史或模拟表现不保证未来结果。",
    simulated_performance_fee_opinion: "# 模拟收益服务费说明\n\n服务费按 UTC 自然周、三张官方策略已平仓 Paper 净收益、高水位和亏损结转计算。账单由运营双人复核后向客户出具。\n\n结清方式有两种：由客户在账单页主动使用钱包余额支付，或按运营指引在站外付款后由运营录入凭证。**平台不会在未经客户操作的情况下自动扣款**，也不会从客户的交易所账户扣款。",
    refund_policy: `# 退款与取消规则\n\n## 钱包余额不可提现\n\n通过充值进入平台的 USDT 计入账户余额，**只能用于购买本平台服务**（开通会员、结算模拟收益服务费）。余额不可提现、不可转出至任何链上地址或第三方账户、不可退回原充值地址。\n\n充值即视为购买服务额度。请按实际需要充值，不要把本平台作为资金存放渠道。\n\n平台不接入任何提现、代付或划转接口，因此不存在「申请提现」这一流程——这不是暂缓开放，是产品边界。\n\n## 已购服务的退款\n\n会员开通后原则上不予退款。因平台原因导致服务不可用的，可联系 ${support} 说明情况，平台记录申请与处理结果；任何退款均为人工处理，系统不会生成自动退款或链上退款成功状态。\n\n## 取消\n\n未支付的订单可自行放弃，不产生费用。已生效的会员在到期前可停止使用，不按剩余天数折算退款。`,
  } satisfies Record<string, string>;
}

function newIdempotencyKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function CommercialDisclosuresWorkspace({ currentUserId, canSubmit, canApprove }: { currentUserId: string; canSubmit: boolean; canApprove: boolean }) {
  const { t } = useAppLocale();
  const control = useApiData<DisclosureControl>("/api/maintenance/commercial-disclosures", t("商业披露读取失败"));
  const settings = useApiData<{ system: SystemSettings }>("/api/maintenance/platform-settings", t("平台身份设置读取失败"));
  if ((control.loading && !control.data) || (settings.loading && !settings.data)) return <LoadingState label={t("正在读取商业披露控制面…")} />;
  if (control.error && !control.data) return <ErrorState message={control.error} retry={control.refresh} />;
  if (settings.error && !settings.data) return <ErrorState message={settings.error} retry={settings.refresh} />;
  if (!control.data || !settings.data) return <ErrorState message={t("商业披露控制面不可用")} retry={async () => { await Promise.all([control.refresh(), settings.refresh()]); }} />;
  return <CommercialDisclosuresEditor
    key={`${control.data.activeBundle?.id ?? "none"}:${JSON.stringify(settings.data.system)}`}
    initial={control.data}
    settings={settings.data.system}
    currentUserId={currentUserId}
    canSubmit={canSubmit}
    canApprove={canApprove}
    refresh={control.refresh}
  />;
}

function CommercialDisclosuresEditor({ initial, settings, currentUserId, canSubmit, canApprove, refresh }: {
  initial: DisclosureControl;
  settings: SystemSettings;
  currentUserId: string;
  canSubmit: boolean;
  canApprove: boolean;
  refresh: () => Promise<void>;
}) {
  const { locale, t } = useAppLocale();
  const initialDocuments = useMemo(() => initial.activeBundle
    ? Object.fromEntries(initial.activeBundle.documents.map((document) => [document.type, document.contentMarkdown]))
    : defaultDocuments(settings), [initial.activeBundle, settings]);
  const [documents, setDocuments] = useState<Record<string, string>>(initialDocuments);
  const [submitReason, setSubmitReason] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submitKey = useRef(newIdempotencyKey("disclosure-submit"));
  const reviewKeys = useRef(new Map<string, string>());
  const identity = {
    operatorName: settings.serviceOperatorName,
    serviceRegion: settings.serviceRegion,
    supportEmail: settings.supportEmail,
    primaryDomain: settings.primaryDomain,
  };
  const identityComplete = Object.values(identity).every((value) => value.trim().length > 0);
  const documentSetComplete = requiredLegalDocumentTypes.every((type) => (documents[type] ?? "").trim().length >= 40);

  async function submit(reason: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/maintenance/commercial-disclosures", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": submitKey.current },
        body: JSON.stringify({ locale: "zh-CN", reason, productIdentity: identity, documents }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = t("商业披露提交失败");
        const detail = apiErrorMessage(payload, fallback);
        throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
      }
      submitKey.current = newIdempotencyKey("disclosure-submit");
      setSubmitReason("");
      setMessage(t("发布申请已提交，必须由另一名有审批权限的运维人员复核后才会生效。"));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("商业披露提交失败"));
    } finally {
      setBusy(false);
    }
  }

  async function decide(request: DisclosureRequest, decision: "approve" | "reject", note: string) {
    setBusy(true);
    setMessage("");
    const key = `${request.id}:${decision}`;
    const commandKey = reviewKeys.current.get(key) ?? newIdempotencyKey("disclosure-review");
    reviewKeys.current.set(key, commandKey);
    try {
      const response = await fetch(`/api/maintenance/commercial-disclosures/${encodeURIComponent(request.id)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": commandKey },
        body: JSON.stringify({ decision, note }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = t("商业披露复核失败");
        const detail = apiErrorMessage(payload, fallback);
        throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
      }
      reviewKeys.current.delete(key);
      setReviewReason("");
      setMessage(decision === "approve" ? t("商业披露已发布；所有客户必须确认这个新版本。") : t("发布申请已拒绝，当前生效版本没有变化。"));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("商业披露复核失败"));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading eyebrow="COMMERCIAL DISCLOSURE CONTROL" title={t("平台商业披露")} description={t("平台维护版本化产品披露；发布采用提交人与复核人分离。这里记录商业合同与产品边界，不宣称外部法律意见。")} actions={<StatusBadge value={initial.readiness.activeBundlePublished ? `${t("生效版本")} ${initial.activeBundle?.version}` : t("尚未发布")} />} />
    <div className="rc-live" aria-live="polite">{message}</div>
    {(canSubmit || canApprove) ? <section className="rc-panel"><header><div><small>INLINE AUDIT</small><h2>{t("发布与复核原因")}</h2><p>{t("填写对应原因后直接执行，不再弹出二次确认；提交人与复核人分离、不可变快照和服务端审计保持不变。")}</p></div></header><div className="rc-form rc-form-grid">{canSubmit ? <InlineAuditReasonField id="disclosure-submit-reason" value={submitReason} onChange={setSubmitReason} label={t("提交原因")} hint={t("提交会保存七项正文、产品身份和内容哈希快照，等待另一人复核。")} /> : null}{canApprove ? <InlineAuditReasonField id="disclosure-review-reason" value={reviewReason} onChange={setReviewReason} label={t("复核原因")} hint={t("批准会发布新版本并要求所有客户重新确认；拒绝不会改变当前版本。")} /> : null}</div></section> : null}
    <section className="rc-panel">
      <header><div><small>PUBLIC IDENTITY SNAPSHOT</small><h2>{t("发布身份与就绪状态")}</h2></div><Link className="rc-button" href="/configurations?tab=platform">{t("修改平台身份")}</Link></header>
      <dl className="rc-description-list">
        <div><dt>{t("服务运营方")}</dt><dd>{identity.operatorName || t("未配置")}</dd></div>
        <div><dt>{t("服务区域")}</dt><dd>{identity.serviceRegion || t("未配置")}</dd></div>
        <div><dt>{t("客服邮箱")}</dt><dd>{identity.supportEmail || t("未配置")}</dd></div>
        <div><dt>{t("主域名")}</dt><dd>{identity.primaryDomain || t("未配置")}</dd></div>
      </dl>
      {!identityComplete ? <p className="rc-error" role="alert">{t("平台身份未配置完整，发布功能保持关闭。")}</p> : null}
    </section>
    <section className="rc-panel">
      <header><div><small>SEVEN VERSIONED DOCUMENTS</small><h2>{t("七项商业披露正文")}</h2></div><span>{documentSetComplete ? t("正文已满足长度校验") : t("正文未齐全")}</span></header>
      <div className="rc-form">
        {requiredLegalDocumentTypes.map((type) => <label className="rc-wide-field" key={type}>{t(labels[type] ?? type)}<textarea rows={7} maxLength={200000} value={documents[type] ?? ""} disabled={!canSubmit || busy} onChange={(event) => setDocuments((current) => ({ ...current, [type]: event.target.value }))} /><small>{(documents[type] ?? "").trim().length} {t("字符 · 发布后内容不可修改")}</small></label>)}
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={!canSubmit || busy || !identityComplete || !documentSetComplete || !hasValidAuditReason(submitReason) || initial.requests.some((request) => request.status === "PENDING")} onClick={() => void submit(submitReason.trim())}>{t("提交另一人复核")}</button></div>
      </div>
    </section>
    <section className="rc-panel">
      <header><div><small>MAKER-CHECKER QUEUE</small><h2>{t("发布申请与历史")}</h2></div></header>
      <div className="rc-card-grid">
        {initial.requests.length === 0 ? <p>{t("暂无发布申请。")}</p> : initial.requests.map((request) => {
          const selfSubmitted = request.submittedByUserId === currentUserId;
          return <article className="rc-card" key={request.id}><header><StatusBadge value={request.status} /><time>{formatDateTime(request.createdAt, locale)}</time></header><h3>{request.productIdentity.operatorName} · {request.locale}</h3><p>{request.submissionReason}</p><dl><div><dt>{t("正文")}</dt><dd>{request.documents.length} {t("项")}</dd></div><div><dt>{t("快照")}</dt><dd title={request.snapshotSha256}>{request.snapshotSha256.slice(0, 12)}…</dd></div></dl>{request.reviewNote ? <p>{t("复核说明：")}{request.reviewNote}</p> : null}{request.status === "PENDING" && selfSubmitted ? <p className="rc-muted">{t("提交人不能复核自己的发布申请。")}</p> : null}{request.status === "PENDING" && canApprove && !selfSubmitted ? <footer className="rc-action-row"><button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(reviewReason)} onClick={() => void decide(request, "reject", reviewReason.trim())}>{t("拒绝")}</button><button className="rc-primary" type="button" disabled={busy || !hasValidAuditReason(reviewReason)} onClick={() => void decide(request, "approve", reviewReason.trim())}>{t("批准发布")}</button></footer> : null}</article>;
        })}
      </div>
    </section>
  </>;
}
