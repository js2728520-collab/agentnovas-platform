import assert from "node:assert/strict";
import test from "node:test";

const { parseLegalMarkdown } = await import("../apps/client/ui/legal-markdown.ts");

test("legal markdown preserves headings, paragraphs and lists as semantic tokens", () => {
  assert.deepEqual(parseLegalMarkdown("# Title\n\nFirst line\nsecond line\n\n- One\n- Two\n\n1. Alpha\n2. Beta"), [
    { type: "heading", level: 1, text: "Title" },
    { type: "paragraph", text: "First line\nsecond line" },
    { type: "unordered-list", items: ["One", "Two"] },
    { type: "ordered-list", items: ["Alpha", "Beta"] },
  ]);
});

test("legal markdown never promotes raw HTML into executable markup", () => {
  assert.deepEqual(parseLegalMarkdown("<script>alert('x')</script>"), [
    { type: "paragraph", text: "<script>alert('x')</script>" },
  ]);
});
