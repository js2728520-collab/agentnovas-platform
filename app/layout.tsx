import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./base.css";

import { resolveAppAudienceStrict } from "@/lib/riverton-apps";
import { rivertonMetadata } from "@/lib/riverton-metadata";
import { themeBootstrapScript } from "@/packages/ui/src/theme-script";

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 必须早于首帧绘制，否则暗色用户会看到一次白闪 */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
