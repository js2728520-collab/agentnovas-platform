"use client";

import { parseAiMessage, type AiMessageSectionKind } from "@/lib/ai-message-presentation";

const sectionIcons: Record<AiMessageSectionKind, string> = {
  body: "AI",
  conclusion: "结",
  evidence: "据",
  invalidations: "界",
  next_step: "步",
  questions: "问",
  strategy_dsl: "DSL",
};

export function AiMessageContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const presentation = parseAiMessage(content);
  return <div className={`ai-message-content${streaming ? " streaming" : ""}`}>
    {presentation.sections.map((section, index) => <section className={`ai-message-section ${section.kind}`} key={`${section.kind}-${index}`}>
      {section.title && <header><span aria-hidden="true">{sectionIcons[section.kind]}</span><h3>{section.title}</h3></header>}
      <div className="ai-message-section-body">
        {section.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}
        {section.items.length > 0 && <ul>{section.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>}
        {section.codeBlocks.map((block, blockIndex) => <details className="ai-message-code" key={blockIndex}>
          <summary>查看 {block.language === "json" ? "JSON 策略草稿" : "结构化内容"}</summary>
          <pre><code>{block.code}</code></pre>
        </details>)}
      </div>
    </section>)}
    {streaming && <span className="ai-message-cursor" aria-hidden="true">▋</span>}
  </div>;
}
