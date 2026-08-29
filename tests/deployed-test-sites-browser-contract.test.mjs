import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../scripts/quality/run-test-sites-acceptance.mjs", import.meta.url), "utf8");

test("deployed browser acceptance is pinned to the three test sites", () => {
  for (const host of ["test.agentnovas.com", "ops-test.agentnovas.com", "main-test.agentnovas.com"]) {
    assert.match(source, new RegExp(`https://${host.replaceAll(".", "\\.")}`));
  }
  assert.doesNotMatch(source, /https:\/\/(?:agentnovas\.com|zht\.agentnovas\.com|xm\.agentnovas\.com)(?:[/'"])/);
  assert.match(source, /ALLOW_TEST_SITE_BROWSER_ACCEPTANCE/);
  assert.match(source, /\/run\/credentials\/three-app-credentials-/);
  assert.match(source, /\/run\/evidence\//);
});

test("deployed browser acceptance exercises the M1 appearance and isolation contract", () => {
  assert.match(source, /localeOptionCount/);
  assert.match(source, /themeModes/);
  assert.match(source, /themePalettes/);
  assert.match(source, /expectNoHorizontalOverflow/);
  assert.match(source, /expectCriticalAccessibility/);
  assert.match(source, /expectHorizontalHubTabs/);
  assert.match(source, /hub tabs must use a horizontal flex layout/);
  assert.match(source, /tabCount >= 3/);
  assert.match(source, /topDelta <= 2/);
  assert.match(source, /window\.scrollTo\(0, 0\)/);
  assert.match(source, /document\.activeElement instanceof HTMLElement/);
  assert.match(source, /client-notifications/);
  assert.match(source, /crossAudienceAnonymous/);
  assert.match(source, /page\.locator\("aside nav"\)/);
  assert.match(source, /navigation must contain exactly five primary entries/);
  assert.match(source, /externalRequests/);
  assert.match(source, /static\.cloudflareinsights\.com/);
  assert.match(source, /edgeInjectedRequests\.push/);
  assert.match(source, /contentType: "application\/javascript; charset=utf-8"/);
  assert.match(source, /edgeInjectedRequests: edgeInjectedRequests\.length/);
  assert.match(source, /edgeInjectedConsoleProblems: edgeInjectedConsoleProblems\.length/);
  assert.match(source, /credentialQueryAttempts/);
  assert.match(source, /let logoutCompleted = false/);
  assert.match(source, /headers: \{ origin: baseUrl, referer: `\$\{baseUrl\}\/` \}/);
  assert.match(source, /finally \{/);
  assert.match(source, /if \(!logoutCompleted\)/);
  assert.match(source, /waitForLoadState\("networkidle"\)/);
  assert.match(source, /consoleProblems/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug)\([^)]*(?:password|credential)/i);
});
