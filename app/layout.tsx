import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./base.css";

import { resolveAppAudienceStrict } from "@/lib/riverton-apps";
import { rivertonMetadata } from "@/lib/riverton-metadata";
import { themeBootstrapScript } from "@/packages/ui/src/theme-script";
import CurrentFrame from "@/app/audience/current-frame";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

export async function generateMetadata(): Promise<Metadata> {
  const audience = resolveAppAudienceStrict({ host: (await headers()).get("host") ?? undefined });
  return rivertonMetadata(audience);
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 应用外壳挂在根 layout：只有根 layout 跨导航保留。放在 app/[...segments] 那层
  // 不行——实测（生产构建）Next 对 catch-all 段的不同取值当作不同路由匹配，会把该层
  // layout 一起重挂，每次点菜单侧栏顶栏都消失约 360ms。
  const requestHeaders = await headers();
  const audience = resolveAppAudienceStrict({ host: requestHeaders.get("host") ?? undefined });
  // proxy.ts 每个请求生成一个 nonce，同时写进 CSP 和 x-nonce 请求头。
  //
  // 不带 nonce 的话这段脚本会被我们自己的 CSP 挡掉（script-src 是
  // 'self' 'nonce-…' 'strict-dynamic'，没有 unsafe-inline）。表现不是报错页，
  // 是暗色用户每次加载都白闪一下——恰恰是这段脚本存在的唯一理由。
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 必须早于首帧绘制，否则暗色用户会看到一次白闪 */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {audience ? <CurrentFrame audience={audience}>{children}</CurrentFrame> : children}
      </body>
    </html>
  );
}
