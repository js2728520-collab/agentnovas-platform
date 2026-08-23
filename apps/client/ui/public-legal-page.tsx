"use client";

import { useApiData } from "@/packages/ui/src/use-api-data";
import { EmptyState, ErrorState, LoadingState } from "@/packages/ui/src/page-state";

import { parseLegalMarkdown } from "./legal-markdown";
import styles from "./public-legal-page.module.css";

/**
 * 公开的条款页面。**不需要登录。**
 *
 * 落地页页脚原本摆着「风险披露、隐私政策、服务条款」三个词——纯文本，点不动，
 * 也没有任何对应页面。视觉上像入口而实际打不开，访客会认为平台把条款藏起来了。
 *
 * 这里只展示**已发布生效**的版本；草稿与待审批的不对外，那是双人复核流程的意义。
 */

type PublicLegalDocument = {
  documentType: string;
  version: number;
  locale: string | null;
  contentSha256: string;
  contentMarkdown: string | null;
};

/** 与运维端的披露类型一一对应，顺序是给访客读的顺序：先说是谁、再说风险。 */
const DOCUMENT_ORDER = [
  "service_entity",
  "jurisdiction",
  "risk_disclosure",
  "terms",
  "privacy",
  "simulated_performance_fee_opinion",
  "refund_policy",
] as const;

const DOCUMENT_LABELS: Record<string, string> = {
  service_entity: "服务运营方",
  jurisdiction: "服务区域与访问限制",
  risk_disclosure: "风险披露",
  terms: "服务条款",
  privacy: "隐私政策",
  simulated_performance_fee_opinion: "模拟收益服务费说明",
  refund_policy: "退款与取消规则",
};

function LegalMarkdown({ source }: { source: string }) {
  return <div className={styles.markdown}>{parseLegalMarkdown(source).map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "heading") return token.level <= 2 ? <h3 key={key}>{token.text}</h3> : <h4 key={key}>{token.text}</h4>;
    if (token.type === "unordered-list") return <ul key={key}>{token.items.map((item, i) => <li key={`${key}-${i}`}>{item}</li>)}</ul>;
    if (token.type === "ordered-list") return <ol key={key}>{token.items.map((item, i) => <li key={`${key}-${i}`}>{item}</li>)}</ol>;
    return <p key={key}>{token.text}</p>;
  })}</div>;
}

export function PublicLegalPage() {
  const resource = useApiData<{ documents: PublicLegalDocument[] }>(
    "/api/platform/legal",
    "条款读取失败",
  );

  if (resource.loading && !resource.data) return <LoadingState label="正在读取条款…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;

  const documents = resource.data?.documents ?? [];
  const ordered = DOCUMENT_ORDER
    .map((type) => documents.find((document) => document.documentType === type))
    .filter((document): document is PublicLegalDocument => Boolean(document));

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>条款与披露</h1>
        <p>以下为当前生效版本。变更会产生新版本，已注册客户需要重新确认后才能继续使用。</p>
      </header>

      {ordered.length === 0 ? (
        // 一条都没发布时说实话，而不是显示一个空壳页面。
        <EmptyState
          title="条款尚未发布"
          description="平台正在准备正式条款文本。在此之前请勿注册或充值——没有可供你确认的条款，就没有可依据的服务约定。"
        />
      ) : (
        <div className={styles.documents}>
          {ordered.map((document) => (
            <section key={document.documentType} id={document.documentType} className={styles.document}>
              <header className={styles.documentHead}>
                <h2>{DOCUMENT_LABELS[document.documentType] ?? document.documentType}</h2>
                <span className={styles.version}>
                  第 {document.version} 版
                  {/* 哈希公开：客户可以核对自己当初同意的版本与现在展示的是否同一份。 */}
                  <code>{document.contentSha256.slice(0, 12)}</code>
                </span>
              </header>
              {document.contentMarkdown
                ? <LegalMarkdown source={document.contentMarkdown} />
                : <p className={styles.missing}>该文档已登记版本但尚未填写正文。</p>}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
