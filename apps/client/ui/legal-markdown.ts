export type LegalMarkdownToken =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] };

const headingPattern = /^(#{1,4})\s+(.+)$/;
const unorderedPattern = /^[-*]\s+(.+)$/;
const orderedPattern = /^\d+\.\s+(.+)$/;

export function parseLegalMarkdown(source: string): LegalMarkdownToken[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const tokens: LegalMarkdownToken[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trimEnd();
    if (!line.trim()) { index += 1; continue; }
    const heading = line.match(headingPattern);
    if (heading) {
      tokens.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    const unordered = line.match(unorderedPattern);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(unorderedPattern);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      tokens.push({ type: "unordered-list", items });
      continue;
    }
    const ordered = line.match(orderedPattern);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(orderedPattern);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      tokens.push({ type: "ordered-list", items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index].trimEnd();
      if (!next.trim() || headingPattern.test(next) || unorderedPattern.test(next) || orderedPattern.test(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    tokens.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return tokens;
}
