import type { NextConfig } from "next";

const appAudience = process.env.RIVERTON_APP_AUDIENCE;
const audienceEntry = appAudience
  ? `@/app/audience/${appAudience}-root`
  : null;
const audienceLocaleEntry = appAudience
  ? "@/packages/ui/src/app-locale-context-runtime"
  : null;
const releaseTag = process.env.RIVERTON_RELEASE_TAG?.trim();
const deploymentId = releaseTag?.replace(/[^A-Za-z0-9_-]/g, "-");
const commitSha = process.env.GIT_COMMIT_SHA?.trim().toLowerCase();
const immutableBuildId = commitSha && /^[a-f0-9]{40}$/.test(commitSha)
  ? `${commitSha.slice(0, 20)}-${appAudience ?? "shared"}`
  : null;

// P2：按 audience 物理拆分 API 面。
//
// app/api 下的路由文件按归属命名（route.client.ts / route.operations.ts /
// route.maintenance.ts / route.internal.ts / route.shared.ts），每个构建只把
// 自己那几个后缀登记为可路由扩展名——**别的 audience 的路由根本不进这个构建**。
//
// 此前三端编译同一份 API 面，公网盒子上跑着运维控制面的代码，只靠
// lib/api-policy.ts 的运行时 fail-closed 校验和 Nginx 白名单兜底。那两层保留，
// 但现在最外层是「代码不存在」。
//
// 后缀与 audience 的对应关系由 scripts/quality/check-architecture-boundaries.mjs
// 对着 lib/api-route-inventory.ts 校验，改了一边另一边会红。
const ROUTE_EXTENSIONS: Record<string, readonly string[]> = {
  client: ["client.ts", "shared.ts"],
  operations: ["operations.ts", "internal.ts", "shared.ts"],
  maintenance: ["maintenance.ts", "internal.ts", "shared.ts"],
};
// 未指定 audience（裸 next dev）时全部登记，否则本地会看不到任何 API。
const routeExtensions = appAudience
  ? ROUTE_EXTENSIONS[appAudience] ?? []
  : [...new Set(Object.values(ROUTE_EXTENSIONS).flat())];
// 质量 E2E 通过正式域名映射回本机端口，Next 开发态需要明确允许其请求内部资源。
const qualityDevOrigins = ["agentnovas.com", "zht.agentnovas.com", "xm.agentnovas.com"];

const nextConfig: NextConfig = {
  output: "standalone",
  pageExtensions: ["ts", "tsx", ...routeExtensions],
  allowedDevOrigins: [...qualityDevOrigins, "127.0.0.1"],
  poweredByHeader: false,
  // 开发指示器的宿主元素落在左上角，路由切换时应用外壳短暂卸载，它就暴露成一个
  // 来路不明的占位块。关掉不影响编译与运行时错误上报。
  devIndicators: false,
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
    ...((audienceEntry || audienceLocaleEntry) ? { resolveAlias: {
      ...(audienceEntry ? { "@/app/audience/current-root": audienceEntry } : {}),
      ...(audienceLocaleEntry ? {
        "@/packages/ui/src/app-locale-context": audienceLocaleEntry,
      } : {}),
    } } : {}),
  },
};

export default nextConfig;
