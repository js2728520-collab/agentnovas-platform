"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import type { CommercialLegalConsentStatus } from "@/packages/contracts/src/commercial-beta";
import { formatDateTime, safeNextPath } from "@/packages/contracts/src/riverton-ui";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

import { clientErrorMessage, clientRequest, newIdempotencyKey } from "./client-api";
import { parseLegalMarkdown } from "./legal-markdown";
import styles from "./legal-consent-experience.module.css";

const documentLabels: Record<string, string> = {
  service_entity: "服务主体",
  jurisdiction: "服务地区",
  privacy: "隐私政策",
  terms: "服务条款",
  risk_disclosure: "风险披露",
  simulated_performance_fee_opinion: "模拟收益服务费说明",
  refund_policy: "退款规则",
};

function LegalMarkdown({ source }: { source: string }) {
  return <div className={styles.legalMarkdown}>{parseLegalMarkdown(source).map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "heading") return token.level <= 2 ? <h3 key={key}>{token.text}</h3> : <h4 key={key}>{token.text}</h4>;
    if (token.type === "unordered-list") return <ul key={key}>{token.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{item}</li>)}</ul>;
    if (token.type === "ordered-list") return <ol key={key}>{token.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{item}</li>)}</ol>;
    return <p key={key}>{token.text}</p>;
  })}</div>;
}

export function LegalConsentExperience() {
  const params = useSearchParams();
  const resource = useApiData<CommercialLegalConsentStatus>("/api/membership/legal-consent", "商业披露读取失败");
  const acknowledgementId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const resultRef = useRef<HTMLDivElement>(null);
  const documents = resource.data?.requiredLegalDocuments;
  const nextPath = safeNextPath(params.get("next"), "/");

  if (resource.loading && !documents) return <LoadingState label="正在读取商业披露…" />;
  if (resource.error && !documents) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data || !Array.isArray(documents)) return <ErrorState message="商业披露接口返回不完整，付费申请保持关闭。" retry={resource.refresh} />;

  const requiredDocuments = documents;
  const complete = resource.data.configurationComplete === true && documents.length === 7;
  const consentComplete = resource.data.consentComplete === true;

  async function acceptLegalDocuments() {
    if (!complete || consentComplete || !acknowledged || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const status = await clientRequest<CommercialLegalConsentStatus>("/api/membership/legal-consent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey.current,
        },
        body: JSON.stringify({ acceptedDocumentVersionIds: requiredDocuments.map((document) => document.id) }),
      }, "商业披露确认保存失败");
      resource.setData(status);
      idempotencyKey.current = newIdempotencyKey();
      setAcknowledged(false);
      setResult({ kind: "success", message: "当前七份正文的版本确认已独立保存；本次操作没有创建订单、付款或激活会员。" });
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (error) {
      setResult({ kind: "error", message: clientErrorMessage(error, "商业披露确认保存失败") });
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  }

  return <section className={styles.root} aria-label="商业披露与确认">
    <PageHeading
      eyebrow="CLIENT DISCLOSURE · VERSIONED CONTRACT"
      title="商业披露与版本确认"
      description="逐项阅读当前有效版本。正文、版本与内容哈希来自服务端；披露未齐全时，系统会阻止付费申请。"
      actions={<StatusBadge value={consentComplete ? "确认已保存" : complete ? "7 / 7 已就绪" : `${documents.length} / 7 未齐全`} />}
    />

    <section className={styles.boundary} aria-labelledby="legal-boundary-title">
      <div>
        <span>确认如何生效</span>
        <h2 id="legal-boundary-title">确认会独立保存，并在提交会员申请时再次绑定订单快照</h2>
        <p>当前页面只记录你对当前七份正文版本的确认，不会创建订单、付款或激活会员。提交申请前，系统仍会把同一组正文版本写入订单快照。</p>
      </div>
      {!consentComplete && complete ? <a className={styles.primaryLink} href="#legal-acceptance">阅读后确认</a> : null}
    </section>

    {!complete && <div className={styles.blocked} role="alert">
      商业披露发布尚未完成。缺少正文、完整性校验或双人复核时不能创建付费申请；平台不会以占位内容代替正式文本。
    </div>}
    <section className={styles.list} aria-label="当前生效的七项商业披露">
      {documents.length === 0 ? <div className={styles.empty}>当前没有可阅读的有效商业披露，付费申请保持关闭。</div> : documents.map((document, index) =>
        <article className={styles.document} key={document.id}>
          <details open={index === 0}>
            <summary>
              <span className={styles.index}>{String(index + 1).padStart(2, "0")}</span>
              <span className={styles.name}>
                <strong>{documentLabels[document.type] ?? document.type}</strong>
                <small>版本 {document.version} · {document.locale ?? "语言未配置"} · 生效于 {formatDateTime(document.effectiveAt)}</small>
              </span>
              <span className={styles.readState}>{document.acceptedAt ? `已确认 ${formatDateTime(document.acceptedAt)}` : document.contentMarkdown ? "可阅读" : "正文缺失"}</span>
            </summary>
            <div className={styles.body}>
              {document.contentMarkdown
                ? <LegalMarkdown source={document.contentMarkdown} />
                : <p role="alert">当前版本没有可供阅读且已校验的正文。</p>}
              <dl className={styles.integrity}>
                <div><dt>版本记录</dt><dd>{document.id}</dd></div>
                <div><dt>内容哈希</dt><dd><code title={document.contentSha256}>{document.contentSha256}</code></dd></div>
              </dl>
            </div>
          </details>
        </article>)}
    </section>

    {complete && !consentComplete && <section className={styles.acceptance} id="legal-acceptance" aria-labelledby="legal-acceptance-title">
      <div>
        <span>VERSIONED CONSENT</span>
        <h2 id="legal-acceptance-title">确认当前七份正文</h2>
        <p>本次确认会保存正文 ID、版本、内容哈希、确认时间及请求环境信息；不会创建会员订单、付款记录或资金流水。</p>
      </div>
      <label className={styles.acknowledgement} htmlFor={acknowledgementId}>
        <input id={acknowledgementId} type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>我已逐项阅读以上七份当前有效正文，并同意保存对应版本与内容哈希。</span>
      </label>
      <button className={styles.primaryLink} type="button" disabled={!acknowledged || busy} onClick={() => void acceptLegalDocuments()}>
        {busy ? "正在保存确认…" : "保存当前版本确认"}
      </button>
    </section>}
    {consentComplete && <section className={styles.completed} aria-label="商业披露确认已完成">
      <div><strong>当前版本确认已完成</strong><span>若任一正文发布新版本，系统会再次要求确认。</span></div>
      <Link className={styles.primaryLink} href={nextPath}>{nextPath === "/" ? "进入客户工作台" : "继续访问原页面"}</Link>
    </section>}
    {result && <div ref={resultRef} className={result.kind === "error" ? styles.error : styles.notice} role={result.kind === "error" ? "alert" : "status"} aria-live={result.kind === "error" ? "assertive" : "polite"} tabIndex={-1}>{result.message}</div>}
  </section>;
}
