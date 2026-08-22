import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

async function jsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Next ${label} manifest at ${path}`, { cause: error });
  }
}

function initialAssetNames(buildManifest, appManifest, routeKey) {
  const routeAssets = appManifest.pages?.[routeKey];
  if (!Array.isArray(routeAssets)) {
    throw new Error(`Next app build manifest has no route assets for ${routeKey}`);
  }
  const rootLayout = Array.isArray(appManifest.pages?.["/layout"])
    ? appManifest.pages["/layout"]
    : [];
  const rootMain = Array.isArray(buildManifest.rootMainFiles)
    ? buildManifest.rootMainFiles
    : [];
  const polyfills = Array.isArray(buildManifest.polyfillFiles) ? buildManifest.polyfillFiles : [];
  const lowPriority = Array.isArray(buildManifest.lowPriorityFiles) ? buildManifest.lowPriorityFiles : [];
  return [...new Set([...polyfills, ...rootMain, ...rootLayout, ...routeAssets, ...lowPriority])]
    .filter((asset) => typeof asset === "string" && /\.(?:js|css)$/.test(asset))
    .sort();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseNext16ClientReference(source, path) {
  const assignment = source.lastIndexOf(" = ");
  const start = source.indexOf("{", assignment);
  const end = source.lastIndexOf(";");
  if (assignment < 0 || start < 0 || end <= start) {
    throw new Error(`Unable to parse Next client reference manifest at ${path}`);
  }
  try {
    return JSON.parse(source.slice(start, end));
  } catch (error) {
    throw new Error(`Unable to parse Next client reference manifest at ${path}`, { cause: error });
  }
}

async function next16RouteAssets(buildDirectory, routeKey) {
  const routeFile = routeKey.replace(/^\//, "");
  const path = join(buildDirectory, "server", "app", `${routeFile}_client-reference-manifest.js`);
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read Next client reference manifest at ${path}`, { cause: error });
  }
  const manifest = parseNext16ClientReference(source, path);
  const routeModule = `[project]/app/${routeFile}`;
  const javascript = [
    ...(manifest.entryJSFiles?.["[project]/app/layout"] ?? []),
    ...(manifest.entryJSFiles?.[routeModule] ?? []),
  ];
  const css = [
    ...(manifest.entryCSSFiles?.["[project]/app/layout"] ?? []),
    ...(manifest.entryCSSFiles?.[routeModule] ?? []),
  ].map((entry) => typeof entry === "string" ? entry : entry?.path).filter(Boolean);
  if (!javascript.length && !css.length) {
    throw new Error(`Next client reference manifest has no route assets for ${routeKey}`);
  }
  return [...javascript, ...css];
}

export async function measureNextInitialAssets(buildDirectory, routeKey = "/page") {
  const buildManifest = await jsonFile(join(buildDirectory, "build-manifest.json"), "build");
  const appManifestPath = join(buildDirectory, "app-build-manifest.json");
  const appManifest = await exists(appManifestPath)
    ? await jsonFile(appManifestPath, "app build")
    : { pages: { [routeKey]: await next16RouteAssets(buildDirectory, routeKey) } };
  const assets = initialAssetNames(buildManifest, appManifest, routeKey);
  if (!assets.length) throw new Error(`Next manifests contain no initial assets for ${routeKey}`);
  let javascriptGzipBytes = 0;
  let cssGzipBytes = 0;
  const files = [];
  for (const asset of assets) {
    let contents;
    try {
      contents = await readFile(join(buildDirectory, asset));
    } catch (error) {
      throw new Error(`Unable to read Next initial asset ${asset}`, { cause: error });
    }
    const gzipBytes = gzipSync(contents, { level: 9 }).byteLength;
    files.push({ asset, rawBytes: contents.byteLength, gzipBytes });
    if (asset.endsWith(".js")) javascriptGzipBytes += gzipBytes;
    if (asset.endsWith(".css")) cssGzipBytes += gzipBytes;
  }
  return { routeKey, assets, files, javascriptGzipBytes, cssGzipBytes };
}

export function assertWithinBundleBudget(measurement, budget = {}) {
  const javascriptBudget = budget.javascriptGzipBytes ?? 200 * 1024;
  const cssBudget = budget.cssGzipBytes ?? 50 * 1024;
  if (measurement.javascriptGzipBytes > javascriptBudget) {
    throw new Error(`Initial JavaScript ${measurement.javascriptGzipBytes} bytes exceeds ${javascriptBudget} byte gzip budget`);
  }
  if (measurement.cssGzipBytes > cssBudget) {
    throw new Error(`Initial CSS ${measurement.cssGzipBytes} bytes exceeds ${cssBudget} byte gzip budget`);
  }
  return measurement;
}
