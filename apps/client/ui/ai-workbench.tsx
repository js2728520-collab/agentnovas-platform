"use client";

import { useState } from "react";

import styles from "./ai-workbench.module.css";
import AiAssistantChat from "./ai-assistant-chat";
import StrategyStudio from "./strategy-studio";

type Mode = "assistant" | "studio";

export default function AiWorkbench({ initialMode = "assistant" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);

  return <section className={styles.workbench} aria-label="AI 工作台">
    <nav className={styles.switcher} aria-label="AI 工作台功能">
      <span className={styles.switcherLabel}>AI 工作台</span>
      <button
        className={`${styles.tab} ${mode === "assistant" ? styles.tabActive : ""}`}
        type="button"
        aria-current={mode === "assistant" ? "page" : undefined}
        onClick={() => setMode("assistant")}
      >AI 助手</button>
      <button
        className={`${styles.tab} ${mode === "studio" ? styles.tabActive : ""}`}
        type="button"
        aria-current={mode === "studio" ? "page" : undefined}
        onClick={() => setMode("studio")}
      >策略研究</button>
    </nav>
    <div className={styles.panel}>
      {mode === "assistant"
        ? <AiAssistantChat title="AI 助手" onOpenStrategies={() => setMode("studio")} />
        : <StrategyStudio />}
    </div>
  </section>;
}
