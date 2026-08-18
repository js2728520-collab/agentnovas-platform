"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  formatAiQuestionAnswers,
  parseAiMessage,
  type AiMessageSectionKind,
} from "@/lib/ai-message-presentation";

const sectionIcons: Record<AiMessageSectionKind, string> = {
  body: "AI",
  conclusion: "结",
  evidence: "据",
  invalidations: "界",
  next_step: "步",
  questions: "问",
  strategy_dsl: "DSL",
};

type AiMessageContentProps = {
  content: string;
  streaming?: boolean;
  autoPrompt?: boolean;
  onAnswer?: (answer: string) => void;
};

export function AiMessageContent({ content, streaming = false, autoPrompt = false, onAnswer }: AiMessageContentProps) {
  const presentation = parseAiMessage(content);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(autoPrompt && presentation.questions.length > 0);
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(
    presentation.questions.map((question) => [question.id, question.defaultOption]),
  ));
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const canSubmit = presentation.questions.every((question) => {
    const selected = answers[question.id] || question.defaultOption;
    return selected !== "__custom__" || Boolean(customAnswers[question.id]?.trim());
  });

  const confirmAnswers = () => {
    const message = formatAiQuestionAnswers(presentation.questions.map((question) => {
      const selected = answers[question.id] || question.defaultOption;
      return {
        prompt: question.prompt,
        answer: selected === "__custom__" ? customAnswers[question.id] || "" : selected,
      };
    }));
    setOpen(false);
    onAnswer?.(message);
  };

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
    {onAnswer && presentation.questions.length > 0 && <aside className="ai-message-question-cta">
      <div><strong>有 {presentation.questions.length} 项需要确认</strong><span>默认已选择推荐项，也可以自行填写。</span></div>
      <button type="button" onClick={() => setOpen(true)}>回答待确认问题</button>
    </aside>}
    {onAnswer && presentation.questions.length > 0 && <dialog
      aria-labelledby={titleId}
      className="ai-answer-dialog"
      onCancel={() => setOpen(false)}
      onClose={() => setOpen(false)}
      ref={dialogRef}
    >
      <form onSubmit={(event) => { event.preventDefault(); confirmAnswers(); }}>
        <header>
          <div><span>QUESTION CONFIRMATION</span><h2 id={titleId}>需要你确认</h2></div>
          <button aria-label="关闭" className="ai-answer-dialog-close" type="button" onClick={() => setOpen(false)}>×</button>
        </header>
        <p className="ai-answer-dialog-intro">已为每个问题预选推荐答案。确认后将作为你的回复继续对话。</p>
        <div className="ai-answer-dialog-fields">
          {presentation.questions.map((question, questionIndex) => <fieldset key={question.id}>
            <legend><span>{questionIndex + 1}</span>{question.prompt}</legend>
            {question.options.map((option) => <label key={option}>
              <input
                checked={(answers[question.id] || question.defaultOption) === option}
                name={question.id}
                onChange={() => setAnswers((current) => ({ ...current, [question.id]: option }))}
                type="radio"
                value={option}
              />
              <span>{option}</span>
            </label>)}
            <label>
              <input
                checked={answers[question.id] === "__custom__"}
                name={question.id}
                onChange={() => setAnswers((current) => ({ ...current, [question.id]: "__custom__" }))}
                type="radio"
                value="__custom__"
              />
              <span>自定义填写</span>
            </label>
            {answers[question.id] === "__custom__" && <input
              aria-label={`${question.prompt}的自定义回答`}
              className="ai-answer-custom-input"
              maxLength={200}
              onChange={(event) => setCustomAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              placeholder="输入你的回答"
              value={customAnswers[question.id] || ""}
            />}
          </fieldset>)}
        </div>
        <footer>
          <button className="secondary" type="button" onClick={() => setOpen(false)}>稍后回答</button>
          <button className="primary" disabled={!canSubmit} type="submit">确认并发送</button>
        </footer>
      </form>
    </dialog>}
    {streaming && <span className="ai-message-cursor" aria-hidden="true">▋</span>}
  </div>;
}
