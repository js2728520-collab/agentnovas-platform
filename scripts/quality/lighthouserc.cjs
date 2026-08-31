const outputDirectory = process.env.QUALITY_LIGHTHOUSE_OUTPUT_DIR || "outputs/quality-lighthouse";
const portOffset = Number(process.env.QUALITY_E2E_PORT_OFFSET || "0");
if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 62500) {
  throw new Error("QUALITY_E2E_PORT_OFFSET must be an integer port offset from 0 through 62500");
}
const clientPort = 3000 + portOffset;
const proxyPort = Number(process.env.QUALITY_LIGHTHOUSE_PROXY_PORT);
if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
  throw new Error("QUALITY_LIGHTHOUSE_PROXY_PORT must name the runner-owned loopback proxy");
}

// Official LHCI configuration reference:
// https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md
module.exports = {
  ci: {
    collect: {
      startServerCommand: `RIVERTON_APP_AUDIENCE=client NODE_USE_ENV_PROXY=1 ./node_modules/.bin/next start -H 127.0.0.1 -p ${clientPort}`,
      // Next prints the Local URL before it has bound the port. Waiting for the
      // actual ready signal prevents LHCI from auditing a stale or unrelated
      // process when the requested port is still occupied.
      startServerReadyPattern: String.raw`\bReady in [0-9]+(?:\.[0-9]+)?(?:ms|s)\b`,
      startServerReadyTimeout: 120000,
      // Chromium treats loopback as a secure context, so the local audit does not
      // invent TLS failures. The runner proxy still rewrites the upstream Host to
      // the real Client audience and rejects every non-loopback destination.
      url: [`http://127.0.0.1:${clientPort}/login`],
      numberOfRuns: 3,
      settings: {
        onlyCategories: ["performance", "accessibility", "best-practices"],
        chromeFlags: [
          "--headless",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-sync",
          "--metrics-recording-only",
          "--no-first-run",
          "--safebrowsing-disable-auto-update",
          `--proxy-server=http://127.0.0.1:${proxyPort}`,
          // Chromium bypasses configured proxies for loopback by default. The
          // negative bypass entry forces the runner-owned allowlist proxy to
          // validate and rewrite the audit request's upstream Host.
          "--proxy-bypass-list=<-loopback>",
        ].join(" "),
      },
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 1 }],
        "categories:best-practices": ["error", { minScore: 0.95 }],
        "largest-contentful-paint": ["error", { maxNumericValue: 2500 }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
        "total-blocking-time": ["error", { maxNumericValue: 200 }],
        "resource-summary:script:size": ["error", { maxNumericValue: 200 * 1024 }],
        "resource-summary:stylesheet:size": ["error", { maxNumericValue: 50 * 1024 }],
        "resource-summary:image:size": ["error", { maxNumericValue: 200 * 1024 }],
      },
    },
    upload: { target: "filesystem", outputDir: outputDirectory },
  },
};
