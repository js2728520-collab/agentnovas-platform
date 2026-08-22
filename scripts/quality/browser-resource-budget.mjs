import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const BUILD_DIRECTORY_BY_HOST = Object.freeze({
  "agentnovas.com": ".next-client",
  "zht.agentnovas.com": ".next-operations",
  "xm.agentnovas.com": ".next-maintenance",
});

export function nextBuildAssetPath(repositoryRoot, resourceUrl) {
  const url = new URL(resourceUrl);
  const buildDirectory = BUILD_DIRECTORY_BY_HOST[url.hostname.toLowerCase()];
  if (!buildDirectory || !url.pathname.startsWith("/_next/static/")) {
    throw new Error("Browser budget accepts only versioned Next static assets");
  }
  const relativePath = decodeURIComponent(url.pathname.slice("/_next/".length));
  if (!/^[A-Za-z0-9._/-]+$/.test(relativePath)
    || relativePath.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error("Unsafe Next static asset path");
  }
  const buildRoot = resolve(repositoryRoot, buildDirectory);
  const assetPath = resolve(buildRoot, relativePath);
  if (!assetPath.startsWith(`${buildRoot}${sep}`)) throw new Error("Next static asset escaped its build directory");
  return assetPath;
}

export async function browserResourceBudget(repositoryRoot, resources) {
  const scriptUrls = new Set();
  const styleUrls = new Set();
  let largestImageBytes = 0;
  for (const resource of resources) {
    const url = new URL(resource.name);
    if (resource.initiatorType === "script" && url.pathname.endsWith(".js")) scriptUrls.add(resource.name);
    if (url.pathname.endsWith(".css")) styleUrls.add(resource.name);
    if (resource.initiatorType === "img") {
      largestImageBytes = Math.max(largestImageBytes, Number(resource.encodedBodySize || resource.transferSize || 0));
    }
  }
  async function gzipTotal(urls) {
    let total = 0;
    for (const url of urls) total += gzipSync(await readFile(nextBuildAssetPath(repositoryRoot, url))).byteLength;
    return total;
  }
  return {
    scripts: await gzipTotal(scriptUrls),
    styles: await gzipTotal(styleUrls),
    largestImage: largestImageBytes,
    scriptAssets: scriptUrls.size,
    styleAssets: styleUrls.size,
  };
}
