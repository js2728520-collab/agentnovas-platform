import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("candidate editor exposes complete structured JSON with accessible inline validation", async () => {
  const editor = await source("../apps/client/ui/strategy-candidate-editor.tsx");

  assert.match(editor, /^"use client";/);
  assert.match(editor, /<textarea/);
  assert.match(editor, /aria-describedby=/);
  assert.match(editor, /spellCheck=\{false\}/);
  assert.match(editor, /JSON\.parse\(draft\)/);
  assert.match(editor, /role="alert"/);
  assert.match(editor, /保存并创建不可变草稿/);
  assert.match(editor, /验证标签将重置为 UNVERIFIED/);
  assert.doesNotMatch(editor, /<dialog|confirm\(/);
});

test("strategy studio sends edited specification and adopts the server canonical result", async () => {
  const studio = await source("../apps/client/ui/strategy-studio.tsx");

  assert.match(studio, /StrategyCandidateEditor/);
  assert.match(studio, /const \[saveBusy, setSaveBusy\] = useState/);
  assert.match(studio, /body: JSON\.stringify\(\{ specification \}\)/);
  assert.match(studio, /dsl: data\.specification/);
  assert.match(studio, /validationLabel: String\(data\.validationLabel\)/);
  assert.match(studio, /edited: Boolean\(data\.edited\)/);
  assert.match(studio, /data\.edited/);
  assert.match(studio, /candidate\.edited \? undefined : evaluationByCandidate\.get/);
  assert.match(studio, /编辑后原评分与回测指标已失效/);
});

test("candidate editor styling uses project tokens and contains wide JSON at narrow viewports", async () => {
  const styles = await source("../apps/client/ui/strategy-studio.module.css");

  assert.match(styles, /\.candidateEditor/);
  assert.match(styles, /\.candidateJson/);
  assert.match(styles, /max-width:\s*100%/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i);
});
