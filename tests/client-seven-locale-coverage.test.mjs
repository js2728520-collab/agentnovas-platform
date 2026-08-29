import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const CLIENT_LOCALES = ["zh-TW", "ru-RU", "es-ES", "ja-JP", "ko-KR"];
const sharedClientSurfaces = [
  "packages/ui/src/app-login.tsx",
  "packages/ui/src/page-state.tsx",
  "packages/ui/src/app-preference-settings.tsx",
  "packages/ui/src/confirm-action-dialog.tsx",
];

function objectProperties(tree, variableName) {
  let initializer = null;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === variableName && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return initializer;
}

function stringPropertyName(property) {
  return ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isNoSubstitutionTemplateLiteral(property.name))
    ? property.name.text
    : null;
}

test("every reachable Client key has a native value in all seven supported locales", async () => {
  const dictionarySource = await readFile(new URL("../packages/ui/src/app-locale-context.tsx", import.meta.url), "utf8");
  const dictionaryTree = ts.createSourceFile("app-locale-context.tsx", dictionarySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const englishObject = objectProperties(dictionaryTree, "english");
  assert.ok(englishObject);
  const englishKeys = new Set(englishObject.properties.map(stringPropertyName).filter(Boolean));

  const clientFiles = (await readdir(new URL("../apps/client/ui", import.meta.url)))
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => `apps/client/ui/${name}`);
  const sourceFiles = [...clientFiles, ...sharedClientSurfaces, "packages/contracts/src/trading-hall.ts"];
  const required = new Set();
  for (const file of sourceFiles) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function collect(node) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /[\u3400-\u9fff]/.test(node.text) && englishKeys.has(node.text)) {
        required.add(node.text);
      }
      ts.forEachChild(node, collect);
    }
    collect(tree);
  }

  const manualObject = objectProperties(dictionaryTree, "clientTranslations");
  assert.ok(manualObject);
  const manual = new Map(CLIENT_LOCALES.map((locale) => [locale, new Set()]));
  for (const localeProperty of manualObject.properties) {
    const locale = stringPropertyName(localeProperty);
    if (!locale || !manual.has(locale) || !ts.isPropertyAssignment(localeProperty) || !ts.isObjectLiteralExpression(localeProperty.initializer)) continue;
    for (const property of localeProperty.initializer.properties) {
      const key = stringPropertyName(property);
      if (key) manual.get(locale).add(key);
    }
  }

  const generatedSource = await readFile(new URL("../packages/ui/src/client-business-translations.generated.ts", import.meta.url), "utf8");
  const generatedTree = ts.createSourceFile("client-business-translations.generated.ts", generatedSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const generatedObject = objectProperties(generatedTree, "generatedClientBusinessTranslations");
  assert.ok(generatedObject);
  const generated = new Map(CLIENT_LOCALES.map((locale) => [locale, new Set()]));
  for (const localeProperty of generatedObject.properties) {
    const locale = stringPropertyName(localeProperty);
    if (!locale || !generated.has(locale) || !ts.isPropertyAssignment(localeProperty) || !ts.isObjectLiteralExpression(localeProperty.initializer)) continue;
    for (const property of localeProperty.initializer.properties) {
      const key = stringPropertyName(property);
      if (key) generated.get(locale).add(key);
    }
  }

  const missing = [];
  for (const locale of CLIENT_LOCALES) {
    for (const key of required) {
      if (!manual.get(locale).has(key) && !generated.get(locale).has(key)) missing.push(`${locale}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);

  const safetyCriticalKeys = [
    "真实订单关闭",
    "不连接真实订单路由",
    "不会执行交易",
    "充值余额只能用于购买本平台服务，不能提现、转出或退款。",
    "钱包余额不足，请先到「钱包」充值后再支付。",
    "模拟收益不是真实投资收益。只有产生正向可计费收益时才会形成应付金额。",
    "链上转账不可撤回，请核对网络和地址并先小额验证。",
    "请勿提交 API Key、密码、私钥或令牌。AI 内容仅用于信息与策略研究，不构成投资建议。",
    "密码已修改，所有会话均已撤销。正在返回登录页…",
  ];
  const criticalMissing = [];
  for (const locale of CLIENT_LOCALES) {
    for (const key of safetyCriticalKeys) {
      if (!manual.get(locale).has(key)) criticalMissing.push(`${locale}: ${key}`);
    }
  }
  assert.deepEqual(criticalMissing, [], "safety-critical financial and security copy requires a hand-reviewed override");
});
