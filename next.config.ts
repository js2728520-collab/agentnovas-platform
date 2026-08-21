import type { NextConfig } from "next";

const appAudience = process.env.RIVERTON_APP_AUDIENCE;
const audienceEntry = appAudience
  ? `@/app/audience/${appAudience}-root`
  : null;
const releaseTag = process.env.RIVERTON_RELEASE_TAG?.trim();
const deploymentId = releaseTag?.replace(/[^A-Za-z0-9_-]/g, "-");
const commitSha = process.env.GIT_COMMIT_SHA?.trim().toLowerCase();
const immutableBuildId = commitSha && /^[a-f0-9]{40}$/.test(commitSha)
  ? `${commitSha.slice(0, 20)}-${appAudience ?? "shared"}`
  : null;

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  ...(deploymentId ? { deploymentId } : {}),
  ...(immutableBuildId ? { generateBuildId: async () => immutableBuildId } : {}),
  headers: async () => [{
    source: "/:path*",
    headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ...(process.env.NODE_ENV === "production"
        ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
        : []),
    ],
  }],
  ...(appAudience ? { distDir: `.next-${appAudience}` } : {}),
  turbopack: {
    root: process.cwd(),
    ...(audienceEntry ? { resolveAlias: { "@/app/audience/current-root": audienceEntry } } : {}),
  },
};

export default nextConfig;
