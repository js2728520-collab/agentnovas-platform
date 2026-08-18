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

export function parseAiMessage(value: string): AiMessagePresentation {
  const normalized = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return { sections: [] };
  const { text, codeBlocks } = extractCodeBlocks(normalized);
  const lines = markSectionHeaders(text).split("\n");
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
  return { sections };
}
