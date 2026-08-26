"use client";

import { useId, useState } from "react";

import styles from "./strategy-studio.module.css";

export default function StrategyCandidateEditor({
  candidateId,
  specification,
  validationLabel,
  saved,
  saving,
  onSave,
}: {
  candidateId: string;
  specification: Record<string, unknown>;
  validationLabel: string;
  saved: boolean;
  saving: boolean;
  onSave: (specification: Record<string, unknown>) => Promise<string | null>;
}) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const canonicalJson = JSON.stringify(specification, null, 2);
  const [draft, setDraft] = useState(canonicalJson);
  const [error, setError] = useState("");

  async function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError("JSON 格式无效，请检查逗号、引号和括号后再保存。");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("策略 DSL 必须是一个 JSON 对象。");
      return;
    }
    setError("");
    const failure = await onSave(parsed as Record<string, unknown>);
    if (failure) setError(failure);
  }

  return <details className={styles.candidateEditor}>
    <summary>
      <span>结构化策略参数</span>
      <small>{saved ? "不可变草稿已保存" : `当前标签 ${validationLabel}`}</small>
    </summary>
    <div className={styles.candidateEditorBody}>
      <label htmlFor={inputId}>完整策略 DSL（JSON）</label>
      <p id={helpId}>
        可编辑全部白名单参数。仅调整格式不会影响验证；任何语义修改后，验证标签将重置为 UNVERIFIED，
        必须重新回测。这里不会触发真实订单。
      </p>
      <textarea
        id={inputId}
        className={styles.candidateJson}
        value={draft}
        onChange={event => { setDraft(event.target.value); setError(""); }}
        aria-describedby={helpId}
        aria-invalid={Boolean(error)}
        disabled={saved || saving}
        spellCheck={false}
        rows={18}
        data-candidate-id={candidateId}
      />
      {error && <p className={styles.candidateEditorError} role="alert">{error}</p>}
      <div className={styles.candidateEditorActions}>
        <button
          type="button"
          className={styles.primary}
          disabled={saved || saving}
          onClick={() => void save()}
        >
          {saved ? "已保存为不可变草稿" : saving ? "正在校验并保存…" : "保存并创建不可变草稿"}
        </button>
      </div>
    </div>
  </details>;
}
