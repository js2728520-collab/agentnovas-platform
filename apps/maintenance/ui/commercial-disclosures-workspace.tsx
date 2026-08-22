"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";

import type { SystemSettings } from "@/lib/platform-settings-contract";
import { requiredLegalDocumentTypes } from "@/lib/commercial-membership-domain";
import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

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
    simulated_performance_fee_opinion: "# 模拟收益服务费说明\n\n服务费按 UTC 自然周、三张官方策略已平仓 Paper 净收益、高水位和亏损结转计算。账单由运营双人复核，不从客户钱包或交易账户自动扣款。",
    refund_policy: `# 退款与取消规则\n\n会费通过外部人工付款并由运营双人复核。退款或取消需联系 ${support}，平台记录申请和处理结果；系统不会生成自动退款或链上退款成功状态。`,
  } satisfies Record<string, string>;
}

function newIdempotencyKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function CommercialDisclosuresWorkspace({ currentUserId, canSubmit, canApprove }: { currentUserId: string; canSubmit: boolean; canApprove: boolean }) {
  const control = useApiData<DisclosureControl>("/api/maintenance/commercial-disclosures", "商业披露读取失败");
  const settings = useApiData<{ system: SystemSettings }>("/api/maintenance/platform-settings", "平台身份设置读取失败");
  if ((control.loading && !control.data) || (settings.loading && !settings.data)) return <LoadingState label="正在读取商业披露控制面…" />;
  if (control.error && !control.data) return <ErrorState message={control.error} retry={control.refresh} />;
  if (settings.error && !settings.data) return <ErrorState message={settings.error} retry={settings.refresh} />;
  if (!control.data || !settings.data) return <ErrorState message="商业披露控制面不可用" retry={async () => { await Promise.all([control.refresh(), settings.refresh()]); }} />;
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
  const initialDocuments = useMemo(() => initial.activeBundle
    ? Object.fromEntries(initial.activeBundle.documents.map((document) => [document.type, document.contentMarkdown]))
    : defaultDocuments(settings), [initial.activeBundle, settings]);
  const [documents, setDocuments] = useState<Record<string, string>>(initialDocuments);
  const [dialog, setDialog] = useState<null | { kind: "submit" } | { kind: "decision"; request: DisclosureRequest; decision: "approve" | "reject" }>(null);
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
      if (!response.ok) throw new Error(apiErrorMessage(payload, "商业披露提交失败"));
      submitKey.current = newIdempotencyKey("disclosure-submit");
      setDialog(null);
      setMessage("发布申请已提交，必须由另一名有审批权限的运维人员复核后才会生效。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "商业披露提交失败");
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
      if (!response.ok) throw new Error(apiErrorMessage(payload, "商业披露复核失败"));
      reviewKeys.current.delete(key);
      setDialog(null);
      setMessage(decision === "approve" ? "商业披露已发布；所有客户必须确认这个新版本。" : "发布申请已拒绝，当前生效版本没有变化。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "商业披露复核失败");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading eyebrow="COMMERCIAL DISCLOSURE CONTROL" title="平台商业披露" description="平台维护版本化产品披露；发布采用提交人与复核人分离。这里记录商业合同与产品边界，不宣称外部法律意见。" actions={<StatusBadge value={initial.readiness.activeBundlePublished ? `生效版本 ${initial.activeBundle?.version}` : "尚未发布"} />} />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-panel">
      <header><div><small>PUBLIC IDENTITY SNAPSHOT</small><h2>发布身份与就绪状态</h2></div><Link className="rc-button" href="/settings">修改平台身份</Link></header>
      <dl className="rc-description-list">
        <div><dt>服务运营方</dt><dd>{identity.operatorName || "未配置"}</dd></div>
        <div><dt>服务区域</dt><dd>{identity.serviceRegion || "未配置"}</dd></div>
        <div><dt>客服邮箱</dt><dd>{identity.supportEmail || "未配置"}</dd></div>
        <div><dt>主域名</dt><dd>{identity.primaryDomain || "未配置"}</dd></div>
      </dl>
      {!identityComplete ? <p className="rc-error" role="alert">平台身份未配置完整，发布功能保持关闭。</p> : null}
    </section>
    <section className="rc-panel">
      <header><div><small>SEVEN VERSIONED DOCUMENTS</small><h2>七项商业披露正文</h2></div><span>{documentSetComplete ? "正文已满足长度校验" : "正文未齐全"}</span></header>
      <div className="rc-form">
        {requiredLegalDocumentTypes.map((type) => <label className="rc-wide-field" key={type}>{labels[type] ?? type}<textarea rows={7} maxLength={200000} value={documents[type] ?? ""} disabled={!canSubmit || busy} onChange={(event) => setDocuments((current) => ({ ...current, [type]: event.target.value }))} /><small>{(documents[type] ?? "").trim().length} 字符 · 发布后内容不可修改</small></label>)}
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={!canSubmit || busy || !identityComplete || !documentSetComplete || initial.requests.some((request) => request.status === "PENDING")} onClick={() => setDialog({ kind: "submit" })}>提交另一人复核</button></div>
      </div>
    </section>
    <section className="rc-panel">
      <header><div><small>MAKER-CHECKER QUEUE</small><h2>发布申请与历史</h2></div></header>
      <div className="rc-card-grid">
        {initial.requests.length === 0 ? <p>暂无发布申请。</p> : initial.requests.map((request) => {
          const selfSubmitted = request.submittedByUserId === currentUserId;
          return <article className="rc-card" key={request.id}><header><StatusBadge value={request.status} /><time>{formatDateTime(request.createdAt)}</time></header><h3>{request.productIdentity.operatorName} · {request.locale}</h3><p>{request.submissionReason}</p><dl><div><dt>正文</dt><dd>{request.documents.length} 项</dd></div><div><dt>快照</dt><dd title={request.snapshotSha256}>{request.snapshotSha256.slice(0, 12)}…</dd></div></dl>{request.reviewNote ? <p>复核说明：{request.reviewNote}</p> : null}{request.status === "PENDING" && selfSubmitted ? <p className="rc-muted">提交人不能复核自己的发布申请。</p> : null}{request.status === "PENDING" && canApprove && !selfSubmitted ? <footer className="rc-action-row"><button className="rc-button" type="button" disabled={busy} onClick={() => setDialog({ kind: "decision", request, decision: "reject" })}>拒绝</button><button className="rc-primary" type="button" disabled={busy} onClick={() => setDialog({ kind: "decision", request, decision: "approve" })}>批准发布</button></footer> : null}</article>;
        })}
      </div>
    </section>
    <ConfirmActionDialog
      open={dialog !== null}
      title={dialog?.kind === "submit" ? "提交商业披露发布" : dialog?.decision === "approve" ? "批准商业披露发布" : "拒绝商业披露发布"}
      description={dialog?.kind === "submit" ? "系统将保存七项正文、产品身份和内容哈希快照，另一名运维人员复核后才会生效。" : "复核决定会写入不可变审计；批准将使所有客户重新确认当前版本。"}
      confirmLabel={dialog?.kind === "submit" ? "确认提交" : dialog?.decision === "approve" ? "确认批准" : "确认拒绝"}
      busy={busy}
      onCancel={() => setDialog(null)}
      onConfirm={(reason) => { if (dialog?.kind === "submit") void submit(reason); else if (dialog?.kind === "decision") void decide(dialog.request, dialog.decision, reason); }}
    />
  </>;
}
