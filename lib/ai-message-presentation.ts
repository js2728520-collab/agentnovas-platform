export type AiMessageSectionKind =
  | "body"
  | "conclusion"
  | "evidence"
  | "invalidations"
  | "next_step"
  | "questions"
  | "strategy_dsl";

export type AiMessageCodeBlock = {
  language: string;
  code: string;
};

export type AiMessageSection = {
  kind: AiMessageSectionKind;
  title: string;
  paragraphs: string[];
  items: string[];
  codeBlocks: AiMessageCodeBlock[];
};

export type AiMessagePresentation = {
  sections: AiMessageSection[];
  questions: AiMessageQuestion[];
};

export type AiMessageQuestion = {
  id: string;
  prompt: string;
  options: string[];
  defaultOption: string;
};

const sectionDefinitions: Record<string, { kind: AiMessageSectionKind; title: string }> = {
  "结论": { kind: "conclusion", title: "结论" },
  "关键证据": { kind: "evidence", title: "关键证据" },
  "失效条件": { kind: "invalidations", title: "失效条件" },
  "下一步": { kind: "next_step", title: "下一步" },
  "待确认问题": { kind: "questions", title: "需要你确认" },
  "JSON DSL 草稿": { kind: "strategy_dsl", title: "策略 DSL 草稿" },
};

function cleanInlineMarkdown(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCodeBlocks(value: string) {
  const codeBlocks: AiMessageCodeBlock[] = [];
  const text = value.replace(/```([\w-]*)\s*\n?([\s\S]*?)```/g, (_match, language: string, code: string) => {
    const index = codeBlocks.push({ language: language || "text", code: code.trim() }) - 1;
    return `\n[[AI_CODE_${index}]]\n`;
  });
  return { text, codeBlocks };
}

function markSectionHeaders(value: string) {
  const labels = Object.keys(sectionDefinitions).join("|");
  const bold = new RegExp(`\\*\\*(${labels})\\*\\*\\s*[:：]?`, "g");
  const line = new RegExp(`(^|\\n)\\s*(?:#{1,6}\\s*)?(${labels})\\s*[:：]?\\s*`, "g");
  return value
    .replace(bold, (_match, label: string) => `\n[[AI_SECTION_${label}]]\n`)
    .replace(line, (_match, prefix: string, label: string) => `${prefix}[[AI_SECTION_${label}]]\n`);
}

function emptySection(label?: string): AiMessageSection {
  const definition = label ? sectionDefinitions[label] : undefined;
  return {
    kind: definition?.kind || "body",
    title: definition?.title || "",
    paragraphs: [],
    items: [],
    codeBlocks: [],
  };
}

function contentSection(label: string | undefined, lines: string[], codeBlocks: AiMessageCodeBlock[]) {
  const section = emptySection(label);
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const text = cleanInlineMarkdown(paragraph.join(" "));
    if (text) section.paragraphs.push(text);
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const codeMatch = line.match(/^\[\[AI_CODE_(\d+)\]\]$/);
    if (codeMatch) {
      flushParagraph();
      const block = codeBlocks[Number(codeMatch[1])];
      if (block) section.codeBlocks.push(block);
      continue;
    }
    if (!line) {
      flushParagraph();
      continue;
    }
    if (
      (section.kind === "questions" || section.kind === "next_step") &&
      /^(?:候选(?:项)?|选项|建议选择)[:：]/.test(cleanInlineMarkdown(line))
    ) {
      continue;
    }
    const item = line.match(/^(?:[-*•]|\d+[.、])\s*(.+)$/);
    if (item) {
      flushParagraph();
      const text = cleanInlineMarkdown(item[1]);
      if (text) section.items.push(text);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return section;
}

function fallbackQuestionOptions(prompt: string) {
  if (/止损/.test(prompt) && /ATR/i.test(prompt)) {
    return ["两者并行，先触发者优先（推荐）", "固定止损优先", "ATR 移动止损优先"];
  }
  if (/重复开仓|再次开仓|加仓/.test(prompt)) {
    return ["持仓期间禁止重复开仓（推荐）", "仅允许一次加仓", "允许按新信号重复开仓"];
  }
  if (/周期|时间框架/.test(prompt)) {
    return ["1 小时周期（推荐）", "4 小时周期", "日线周期"];
  }
  if (/最大回撤|回撤上限/.test(prompt)) {
    return ["10%（推荐）", "15%", "20%"];
  }
  return ["采用推荐设置（推荐）", "保持当前设置", "暂不确定，请继续说明"];
}

function extractQuestions(value: string): AiMessageQuestion[] {
  const rows: Array<{ prompt: string; options: string[] }> = [];
  let active = false;
  let current: { prompt: string; options: string[] } | undefined;

  for (const rawLine of value.split("\n")) {
    const header = rawLine.trim().match(/^\[\[AI_SECTION_(.+)\]\]$/);
    if (header) {
      active = header[1] === "下一步" || header[1] === "待确认问题";
      current = undefined;
      continue;
    }
    if (!active) continue;
    const line = cleanInlineMarkdown(rawLine.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, ""));
    if (!line) continue;
    const candidate = line.match(/^(?:候选(?:项)?|选项|建议选择)[:：]\s*(.+)$/);
    if (candidate && current) {
      current.options = candidate[1]
        .split(/[|｜]/)
        .map((option) => cleanInlineMarkdown(option).slice(0, 120))
        .filter(Boolean)
        .slice(0, 4);
      continue;
    }
    if (/[?？]$/.test(line)) {
      current = { prompt: line.slice(0, 200), options: [] };
      rows.push(current);
    }
  }

  return rows.slice(0, 4).map((row, index) => {
    const uniqueOptions = [...new Set(row.options)];
    const options = uniqueOptions.length >= 2 ? uniqueOptions : fallbackQuestionOptions(row.prompt);
    return {
      id: `question-${index + 1}`,
      prompt: row.prompt,
      options,
      defaultOption: options[0],
    };
  });
}

export function formatAiQuestionAnswers(answers: Array<{ prompt: string; answer: string }>) {
  const rows = answers
    .map(({ prompt, answer }) => ({
      prompt: prompt.trim(),
      answer: answer.trim().replace(/[（(]推荐[）)]\s*$/, ""),
    }))
    .filter(({ prompt, answer }) => prompt && answer)
    .slice(0, 4);
  return [
    "关于你提出的待确认问题，我的选择是：",
    ...rows.flatMap(({ prompt, answer }, index) => [
      `${index + 1}. ${prompt}`,
      `   回答：${answer}`,
    ]),
  ].join("\n");
}

export function hasStrategyDslCodeBlock(presentation: AiMessagePresentation) {
  return presentation.sections.some((section) => section.codeBlocks.some((block) => {
    if (block.language.toLowerCase() !== "json") return false;
    try {
      const value = JSON.parse(block.code) as Record<string, unknown>;
      const entry = value.entry && typeof value.entry === "object"
        ? value.entry as Record<string, unknown>
        : {};
      const entryWhen = entry.when && typeof entry.when === "object"
        ? entry.when as Record<string, unknown>
        : {};
      const entryRules = Array.isArray(entry.all)
        ? entry.all
        : Array.isArray(entry.conditions)
          ? entry.conditions
          : Array.isArray(entryWhen.all)
            ? entryWhen.all
            : [];
      const supportedRule = entryRules.some((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const rule = candidate as Record<string, unknown>;
        return ["ema_cross", "rsi_threshold", "channel_breakout", "volume_ratio"].includes(String(rule.type || ""))
          || Array.isArray(rule.crossesAbove)
          || Array.isArray(rule.crossesBelow)
          || Array.isArray(rule.gt)
          || Array.isArray(rule.gte);
      });
      const schemaVersionSupported = value.schemaVersion === undefined
        || value.schemaVersion === 1
        || value.schemaVersion === "1.0";
      const sideSupported = value.side === undefined || value.side === "long" || value.side === "long_only";
      return schemaVersionSupported
        && sideSupported
        && typeof value.name === "string"
        && typeof value.symbol === "string"
        && typeof value.timeframe === "string"
        && Boolean(value.entry && typeof value.entry === "object")
        && Boolean(value.exit && typeof value.exit === "object")
        && Boolean((value.risk && typeof value.risk === "object")
          || (value.capitalManagement && typeof value.capitalManagement === "object"))
        && (supportedRule || value.schemaVersion === 1 || value.schemaVersion === "1.0");
    } catch {
      return false;
    }
  }));
}

export function parseAiMessage(value: string): AiMessagePresentation {
  const normalized = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return { sections: [], questions: [] };
  const { text, codeBlocks } = extractCodeBlocks(normalized);
  const markedText = markSectionHeaders(text);
  const lines = markedText.split("\n");
  const sections: AiMessageSection[] = [];
  let label: string | undefined;
  let content: string[] = [];

  const flush = () => {
    const section = contentSection(label, content, codeBlocks);
    if (section.paragraphs.length || section.items.length || section.codeBlocks.length) sections.push(section);
    content = [];
  };

  for (const line of lines) {
    const header = line.trim().match(/^\[\[AI_SECTION_(.+)\]\]$/);
    if (header && sectionDefinitions[header[1]]) {
      flush();
      label = header[1];
    } else {
      content.push(line);
    }
  }
  flush();
  return { sections, questions: extractQuestions(markedText) };
}
