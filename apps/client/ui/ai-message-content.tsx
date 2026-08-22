"use client";

import { useEffect, useId, useRef, useState } from "react";

import styles from "./ai-message-content.module.css";

import {
  formatAiQuestionAnswers,
  hasStrategyDslCodeBlock,
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
  onSaveStrategy?: () => void;
  strategySaveState?: "idle" | "saving" | "saved";
  strategySaveNotice?: string;
};

export function AiMessageContent({
  content,
  streaming = false,
  autoPrompt = false,
  onAnswer,
  onSaveStrategy,
  strategySaveState = "idle",
  strategySaveNotice,
}: AiMessageContentProps) {
  const presentation = parseAiMessage(content);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(autoPrompt && presentation.questions.length > 0);
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(
    presentation.questions.map((question) => [question.id, question.defaultOption]),
  ));
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const hasStrategyDsl = hasStrategyDslCodeBlock(presentation);

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
      <div className={styles.body}>
        {section.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}
        {section.items.length > 0 && <ul>{section.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>}
        {section.codeBlocks.map((block, blockIndex) => <details className={styles.code} key={blockIndex}>
          <summary>查看 {block.language === "json" ? "JSON 策略草稿" : "结构化内容"}</summary>
          <pre><code>{block.code}</code></pre>
        </details>)}
      </div>
    </section>)}
    {onAnswer && presentation.questions.length > 0 && <div aria-label="待确认问题" className={styles.questionCta} role="group">
      <div><strong>有 {presentation.questions.length} 项需要确认</strong><span>默认已选择推荐项，也可以自行填写。</span></div>
      <button type="button" onClick={() => setOpen(true)}>回答待确认问题</button>
    </div>}
    {onSaveStrategy && hasStrategyDsl && <div aria-label="策略保存操作" className={styles.strategySave} role="group">
      <div><strong>已识别策略 DSL</strong><span>{strategySaveNotice || "保存时服务端会转换并校验为平台可回测规则，作为自用草稿进入“我的策略”。"}</span></div>
      <button
        disabled={strategySaveState !== "idle"}
        onClick={onSaveStrategy}
        type="button"
      >{strategySaveState === "saving" ? "正在保存…" : strategySaveState === "saved" ? "已保存到我的策略" : "保存到我的策略"}</button>
    </div>}
    {onAnswer && presentation.questions.length > 0 && <dialog
      aria-labelledby={titleId}
      className={styles.dialog}
      onCancel={() => setOpen(false)}
      onClose={() => setOpen(false)}
      ref={dialogRef}
    >
      <form onSubmit={(event) => { event.preventDefault(); confirmAnswers(); }}>
        <header>
          <div><span>QUESTION CONFIRMATION</span><h2 id={titleId}>需要你确认</h2></div>
          <button aria-label="关闭" className={styles.dialogClose} type="button" onClick={() => setOpen(false)}>×</button>
        </header>
        <p className={styles.dialogIntro}>已为每个问题预选推荐答案。确认后将作为你的回复继续对话。</p>
        <div className={styles.dialogFields}>
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
              className={styles.customInput}
              maxLength={200}
              onChange={(event) => setCustomAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              placeholder="输入你的回答"
              value={customAnswers[question.id] || ""}
            />}
          </fieldset>)}
        </div>
        <footer>
          <button className={styles.secondary} type="button" onClick={() => setOpen(false)}>稍后回答</button>
          <button className={styles.primary} disabled={!canSubmit} type="submit">确认并发送</button>
        </footer>
      </form>
    </dialog>}
    {streaming && <span className={styles.cursor} aria-hidden="true">▋</span>}
  </div>;
}
