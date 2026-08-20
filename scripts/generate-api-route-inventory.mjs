import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const apiRoot = resolve(repositoryRoot, "app/api");
const rbacPath = resolve(repositoryRoot, "lib/rbac.ts");

const ALL_AUDIENCES = ["client", "operations", "maintenance"];
const INTERNAL_AUDIENCES = ["operations", "maintenance"];
const OPERATIONS_PREFIXES = [
  "/api/approvals", "/api/attributions", "/api/data-center", "/api/employee", "/api/finance",
  "/api/invitations", "/api/operations", "/api/organization", "/api/public-pool", "/api/reports", "/api/team",
];
const CLIENT_PREFIXES = [
  "/api/account", "/api/ai", "/api/automation", "/api/exchange-accounts", "/api/integrations/catalog",
  "/api/market", "/api/notifications", "/api/platform", "/api/portfolio", "/api/risk", "/api/simulated-orders",
  "/api/strategies", "/api/strategy-", "/api/trading", "/api/wallet",
];
const CURRENT_ACCESS_PERMISSIONS = {
  requireCurrentAccessAdmin: {
    operations: ["ops.roles.manage"],
    maintenance: ["maint.roles.manage"],
  },
  requireCurrentAccessViewer: {
    operations: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"],
    maintenance: ["maint.roles.manage", "maint.roles.approve_sensitive"],
  },
  requireCurrentAccessAssignmentAdmin: {
    operations: ["ops.roles.assign", "ops.roles.manage"],
    maintenance: ["maint.roles.manage"],
  },
  requireCurrentAccessReviewer: {
    operations: ["ops.roles.approve_sensitive", "ops.roles.manage"],
    maintenance: ["maint.roles.approve_sensitive", "maint.roles.manage"],
  },
  requireCurrentAccessAudit: {
    operations: ["ops.roles.manage", "ops.roles.approve_sensitive"],
    maintenance: ["maint.audit.view", "maint.roles.manage"],
  },
};

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

function routePattern(filename) {
  const local = relative(apiRoot, filename).split(sep).join("/").replace(/\/route\.ts$/, "");
  return `/api/${local}`
    .replace(/\[\.\.\.([^\]]+)\]/g, ":$1*")
    .replace(/\[([^\]]+)\]/g, ":$1");
}

function hasPrefix(route, prefixes) {
  return prefixes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`) || route.startsWith(prefix));
}

function basePolicy(route, method) {
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (route === "/api/credits/me" || route === "/api/membership" || route.startsWith("/api/membership/")) {
    return { audiences: ["client"], authentication: "session", sameOrigin: mutation };
  }
  if (route === "/api/auth/login" || route === "/api/auth/logout" || route === "/api/auth/me") {
    return { audiences: ALL_AUDIENCES, authentication: route === "/api/auth/login" ? "anonymous" : "session", sameOrigin: mutation };
  }
  if (route === "/api/auth/mfa/verify") {
    return { audiences: INTERNAL_AUDIENCES, authentication: "session", sameOrigin: true };
  }
  if (route.startsWith("/api/auth/")) return { audiences: ["client"], authentication: "anonymous", sameOrigin: mutation };
  if (route === "/api/system/bootstrap") return { audiences: ["maintenance"], authentication: "bootstrap", sameOrigin: false };
  if (route.startsWith("/api/integrations/resend/webhook") || route.startsWith("/api/integrations/payments/")) {
    return { audiences: ["maintenance"], authentication: "webhook", sameOrigin: false };
  }
  if (route === "/api/access/me/effective") return { audiences: INTERNAL_AUDIENCES, authentication: "session", sameOrigin: false };
  if (route.startsWith("/api/access/")) return { audiences: INTERNAL_AUDIENCES, authentication: "permission", sameOrigin: mutation };
  if (route.startsWith("/api/maintenance/") || route.startsWith("/api/admin/")) {
    return { audiences: ["maintenance"], authentication: "permission", sameOrigin: mutation };
  }
  if (hasPrefix(route, OPERATIONS_PREFIXES)) return { audiences: ["operations"], authentication: "permission", sameOrigin: mutation };
  if (hasPrefix(route, CLIENT_PREFIXES)) return { audiences: ["client"], authentication: "session", sameOrigin: mutation };
  if (route === "/api/health") return { audiences: ALL_AUDIENCES, authentication: "anonymous", sameOrigin: false };
  throw new Error(`Policy not registered for ${method} ${route}`);
}

function parsedFunctions(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = new Map(file.statements.filter((statement) => ts.isFunctionDeclaration(statement) && statement.name)
    .map((statement) => [statement.name.text, statement]));
  const methods = file.statements.filter((statement) => ts.isFunctionDeclaration(statement)
    && statement.name
    && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(statement.name.text)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  return { functions, methods };
}

function stringsIn(node) {
  const values = [];
  function visit(current) {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) values.push(current.text);
    ts.forEachChild(current, visit);
  }
  if (node) visit(node);
  return values;
}

function permissionKeysFor(methodNode, audiences, constants, functions) {
  const keys = new Set();
  const visitedFunctions = new Set();
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = node.expression.text;
      if (helper === "requireAccessPermission" || helper === "requireAnyAccessPermission") {
        for (const key of stringsIn(node.arguments[1])) {
          if (/^(client|ops|maint)\.[a-z0-9_.]+$/.test(key)) keys.add(key);
        }
        const argument = node.arguments[1];
        if (argument && ts.isIdentifier(argument) && constants.has(argument.text)) keys.add(constants.get(argument.text));
      }
      const mapping = CURRENT_ACCESS_PERMISSIONS[helper];
      if (mapping) {
        for (const audience of audiences) for (const key of mapping[audience] ?? []) keys.add(key);
      }
      const localFunction = functions.get(helper);
      if (localFunction && !visitedFunctions.has(helper)) {
        visitedFunctions.add(helper);
        visit(localFunction);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(methodNode);
  return [...keys].sort();
}

function sensitivePermissionKeys(source) {
  const file = ts.createSourceFile(rbacPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const keys = new Set();
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const key = node.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(file) === "key");
      const sensitive = node.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(file) === "sensitive");
      if (key && sensitive && ts.isPropertyAssignment(key) && ts.isStringLiteral(key.initializer)
        && ts.isPropertyAssignment(sensitive) && sensitive.initializer.kind === ts.SyntaxKind.TrueKeyword) keys.add(key.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return keys;
}

function piiForRoute(route) {
  if (["/api/data-center", "/api/employee/tasks", "/api/organization/members"].includes(route)
    || route.startsWith("/api/finance/payout-profiles") || route.startsWith("/api/operations/deposits")) return "full";
  if (route.startsWith("/api/organization/customers") || route.startsWith("/api/team/")) return "masked";
  return "none";
}

const outputPath = resolve(repositoryRoot, "lib/api-route-inventory.ts");
const sensitiveKeys = sensitivePermissionKeys(await readFile(rbacPath, "utf8"));
const entries = [];
for (const filename of (await files(apiRoot)).filter((path) => path.endsWith("/route.ts")).sort()) {
  const source = await readFile(filename, "utf8");
  const route = routePattern(filename);
  const constants = new Map([...source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["']((?:client|ops|maint)\.[a-z0-9_.]+)["']/g)]
    .map((match) => [match[1], match[2]]));
  const parsed = parsedFunctions(source, filename);
  for (const methodNode of parsed.methods) {
    const method = methodNode.name.text;
    const policy = basePolicy(route, method);
    const permissionKeys = policy.authentication === "permission" ? permissionKeysFor(methodNode, policy.audiences, constants, parsed.functions) : [];
    if (policy.authentication === "permission" && permissionKeys.length === 0) {
      throw new Error(`${method} ${route} is permission-classified but does not call an exact DB authorization helper`);
    }
    const sensitive = permissionKeys.some((key) => sensitiveKeys.has(key));
    entries.push({
      method,
      route,
      source: relative(repositoryRoot, filename).split(sep).join("/"),
      audiences: policy.audiences,
      authentication: policy.authentication,
      permissionKeys,
      scope: policy.authentication === "permission" && policy.audiences.length === 1 && policy.audiences[0] === "maintenance" ? "platform"
        : policy.authentication === "permission" ? "grant" : "none",
      mfa: sensitive && !policy.audiences.includes("client") ? "recent" : "none",
      pii: piiForRoute(route),
      sensitivity: sensitive || policy.authentication === "webhook" || policy.authentication === "bootstrap" ? "sensitive" : "normal",
      requiresSameOrigin: policy.sameOrigin,
    });
  }
}

entries.sort((left, right) => left.route.localeCompare(right.route) || left.method.localeCompare(right.method));
const contents = `// Generated by scripts/generate-api-route-inventory.mjs. Do not edit by hand.\n` +
  `import type { AppAudience } from "./riverton-apps.ts";\n\n` +
  `export type ApiRouteInventoryEntry = {\n` +
  `  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";\n` +
  `  route: string;\n` +
  `  source: string;\n` +
  `  audiences: readonly AppAudience[];\n` +
  `  authentication: "anonymous" | "session" | "permission" | "webhook" | "bootstrap";\n` +
  `  permissionKeys: readonly string[];\n` +
  `  scope: "none" | "grant" | "platform";\n` +
  `  mfa: "none" | "recent";\n` +
  `  pii: "none" | "masked" | "full";\n` +
  `  sensitivity: "normal" | "sensitive";\n` +
  `  requiresSameOrigin: boolean;\n` +
  `};\n\n` +
  `export const API_ROUTE_INVENTORY = ${JSON.stringify(entries, null, 2)} as const satisfies readonly ApiRouteInventoryEntry[];\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== contents) throw new Error("lib/api-route-inventory.ts is stale; run node scripts/generate-api-route-inventory.mjs");
  process.stdout.write(`Verified ${entries.length} API method routes and security metadata.\n`);
} else {
  await writeFile(outputPath, contents, "utf8");
  process.stdout.write(`Generated ${entries.length} API method routes with executable security metadata.\n`);
}
