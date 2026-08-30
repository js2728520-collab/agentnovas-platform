import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const localizedSurfaces = [
  "packages/ui/src/app-login.tsx",
  "packages/ui/src/console-shell.tsx",
  "packages/ui/src/page-state.tsx",
  "packages/ui/src/internal-settings-workspace.tsx",
  "packages/ui/src/internal-account-security.tsx",
  "packages/ui/src/access-center.tsx",
  "packages/ui/src/email-service-manager/email-service-manager.tsx",
  "packages/ui/src/email-service-manager/email-service-overview.tsx",
  "packages/ui/src/email-service-manager/email-service-configuration.tsx",
  "packages/ui/src/email-service-manager/email-service-tests.tsx",
  "apps/client/ui/client-portal-shell.tsx",
  "apps/client/ui/client-home-workspace.tsx",
  "apps/client/ui/client-notification-settings.tsx",
  "apps/client/ui/notification-preferences-workspace.tsx",
  "apps/client/ui/account-security-workspace.tsx",
  "apps/client/ui/client-mfa-panel.tsx",
  "apps/client/ui/support-workspace.tsx",
  "apps/client/ui/strategy-center-unavailable.tsx",
  "apps/client/ui/ai-assistant-chat.tsx",
  "apps/client/ui/live-market.tsx",
  "apps/client/ui/trading-experience.tsx",
  "apps/client/ui/decision-hall.tsx",
  "apps/client/ui/work-records-workspace.tsx",
  "apps/client/ui/work-record-detail.tsx",
  "apps/client/ui/credit-workspace.tsx",
  "apps/client/ui/wallet-workspace.tsx",
  "apps/client/ui/deposit-workspace.tsx",
  "apps/client/ui/membership-experience.tsx",
  "apps/client/ui/performance-statements-workspace.tsx",
  "apps/client/ui/client-notifications.tsx",
  "apps/client/ui/public-legal-page.tsx",
  "apps/client/ui/legal-consent-experience.tsx",
  "apps/operations/ui/operations-app.tsx",
  "apps/operations/ui/operations-overview.tsx",
  "apps/operations/ui/customers-workspace.tsx",
  "apps/operations/ui/data-center-workspace.tsx",
  "apps/operations/ui/ledger-workspace.tsx",
  "apps/operations/ui/finance-workspace.tsx",
  "apps/operations/ui/accounts-workspace.tsx",
  "apps/operations/ui/deposits-workspace.tsx",
  "apps/operations/ui/team-workspace.tsx",
  "apps/operations/ui/approvals-workspace.tsx",
  "apps/operations/ui/membership-orders-workspace.tsx",
  "apps/operations/ui/credits-workspace.tsx",
  "apps/operations/ui/performance-statements-workspace.tsx",
  "apps/operations/ui/payment-evidence-form.tsx",
  "apps/operations/ui/invitations-workspace.tsx",
  "apps/operations/ui/kill-switch-workspace.tsx",
  "apps/operations/ui/live-routing-workspace.tsx",
  "apps/maintenance/ui/maintenance-app.tsx",
  "apps/maintenance/ui/ai-usage-workspace.tsx",
  "apps/maintenance/ui/models-workspace.tsx",
  "apps/maintenance/ui/configuration-versions-workspace.tsx",
  "apps/maintenance/ui/configuration-version-create-panel.tsx",
  "apps/maintenance/ui/configuration-version-detail-panel.tsx",
  "apps/maintenance/ui/commercial-disclosures-workspace.tsx",
  "apps/maintenance/ui/release-management-workspace.tsx",
  "apps/maintenance/ui/demo-exchanges-workspace.tsx",
  "apps/maintenance/ui/system-overview-workspace.tsx",
  "apps/maintenance/ui/integrations-overview.tsx",
  "apps/maintenance/ui/email-integration-workspace.tsx",
  "apps/maintenance/ui/payment-integration-workspace.tsx",
  "apps/maintenance/ui/readiness-workspace.tsx",
  "apps/maintenance/ui/platform-settings-workspace.tsx",
  "apps/maintenance/ui/source-integrations-workspace.tsx",
  "apps/maintenance/ui/technical-audit-workspace.tsx",
  "apps/maintenance/ui/emergency-control-workspace.tsx",
  "apps/maintenance/ui/work-record-export-workspace.tsx",
  "apps/maintenance/ui/system-health-workspace.tsx",
];

const cjk = /[\u3400-\u9fff]/;
const selfLocalizingComponents = new Set([
  "AccessDenied",
  "ConfirmActionDialog",
  "ConsoleHubTabs",
  "EmptyState",
  "ErrorState",
  "EvidenceList",
  "LoadingState",
  "PageHeading",
  "StatusBadge",
]);

test("localized application surfaces do not leave Chinese text directly in JSX", async () => {
  const findings = [];
  for (const file of localizedSurfaces) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxText(node) && cjk.test(node.text.trim())) findings.push(`${file}: JSX text ${node.text.trim()}`);
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && cjk.test(node.initializer.text)) {
        const element = node.parent.parent;
        const tag = ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? element.tagName.getText(tree) : "";
        const intrinsic = tag && tag[0] === tag[0]?.toLowerCase();
        if (tag && (intrinsic || !selfLocalizingComponents.has(tag))) findings.push(`${file}: ${tag}.${node.name.getText(tree)}=${node.initializer.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  assert.deepEqual(findings, []);
});

test("every Chinese key passed to t on localized surfaces has an English value", async () => {
  const dictionarySource = await readFile(new URL("../packages/ui/src/app-locale-context.tsx", import.meta.url), "utf8");
  const dictionaryTree = ts.createSourceFile("app-locale-context.tsx", dictionarySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const englishKeys = new Set();
  function collectEnglish(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(dictionaryTree) === "english" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isNoSubstitutionTemplateLiteral(property.name))) englishKeys.add(property.name.text);
      }
    }
    ts.forEachChild(node, collectEnglish);
  }
  collectEnglish(dictionaryTree);
  const missing = [];
  for (const file of localizedSurfaces) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\bt\("([^"]*[\u3400-\u9fff][^"]*)"\)/g)) {
      if (!englishKeys.has(match[1])) missing.push(`${file}: ${match[1]}`);
    }
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function collectSelfLocalizedAttributes(node) {
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && cjk.test(node.initializer.text)) {
        const element = node.parent.parent;
        const tag = ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? element.tagName.getText(tree) : "";
        if (selfLocalizingComponents.has(tag) && !englishKeys.has(node.initializer.text)) {
          missing.push(`${file}: ${node.initializer.text}`);
        }
      }
      ts.forEachChild(node, collectSelfLocalizedAttributes);
    }
    collectSelfLocalizedAttributes(tree);
  }
  assert.deepEqual(missing, []);
});

test("server-owned integration catalog descriptions have an English presentation value", async () => {
  const [catalog, dictionary] = await Promise.all([
    readFile(new URL("../lib/integration-catalog.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/ui/src/app-locale-context.tsx", import.meta.url), "utf8"),
  ]);
  const sourceDescriptions = [...catalog.matchAll(/description: "([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)]
    .map((match) => match[1]);
  const missing = sourceDescriptions.filter((description) => !dictionary.includes(`${JSON.stringify(description)}:`));
  assert.deepEqual(missing, []);
});

test("server-owned Operations role labels have an English presentation value", async () => {
  const [permissions, dictionary] = await Promise.all([
    readFile(new URL("../lib/permissions.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/ui/src/app-locale-context.tsx", import.meta.url), "utf8"),
  ]);
  const labels = [...permissions.matchAll(/:\s*"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)]
    .map((match) => match[1]);
  const missing = labels.filter((label) => !dictionary.includes(`${JSON.stringify(label)}:`));
  assert.deepEqual(missing, []);
});

test("server-owned trading-agent catalog copy has an English presentation value", async () => {
  const [catalog, dictionary] = await Promise.all([
    readFile(new URL("../packages/contracts/src/trading-hall.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/ui/src/app-locale-context.tsx", import.meta.url), "utf8"),
  ]);
  const values = [...catalog.matchAll(/(?:name|question|outputName):\s*"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)]
    .map((match) => match[1]);
  const missing = values.filter((value) => !dictionary.includes(`${JSON.stringify(value)}:`));
  assert.deepEqual(missing, []);
});

test("Maintenance disclosure document labels have an English presentation value", async () => {
  const [workspace, dictionary] = await Promise.all([
    readFile(new URL("../apps/maintenance/ui/commercial-disclosures-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../packages/ui/src/app-locale-context.tsx", import.meta.url), "utf8"),
  ]);
  const labelBlock = workspace.match(/const labels:[\s\S]*?\n};/)?.[0] ?? "";
  const labels = [...labelBlock.matchAll(/:\s*"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)].map((match) => match[1]);
  const missing = labels.filter((label) => !dictionary.includes(`${JSON.stringify(label)}:`));
  assert.deepEqual(missing, []);
});

test("Maintenance Demo strategy labels have an English presentation value", async () => {
  const [workspace, dictionary] = await Promise.all([
    readFile(new URL("../apps/maintenance/ui/demo-exchanges-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../packages/ui/src/app-locale-context.tsx", import.meta.url), "utf8"),
  ]);
  const labelBlock = workspace.match(/const strategyLabels:[\s\S]*?\n};/)?.[0] ?? "";
  const labels = [...labelBlock.matchAll(/:\s*"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)].map((match) => match[1]);
  const missing = labels.filter((label) => !dictionary.includes(`${JSON.stringify(label)}:`));
  assert.deepEqual(missing, []);
});
