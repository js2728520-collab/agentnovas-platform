import type { Metadata } from "next";

import type { AppAudience } from "./riverton-apps.ts";

const icons = { icon: "/favicon.svg", shortcut: "/favicon.svg" } as const;

export function rivertonMetadata(audience: AppAudience | null): Metadata {
  if (audience === "operations") return {
    title: "Riverton Capital 运营端",
    description: "Riverton Capital 客户、会员、账务与审批工作台。",
    icons,
    robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  };
  if (audience === "maintenance") return {
    title: "Riverton Capital 运维端",
    description: "Riverton Capital 模型、集成、安全与系统健康工作台。",
    icons,
    robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  };
  if (audience === "client") return {
    title: "Riverton Capital 客户端",
    description: "Riverton Capital AI 策略研发、回测与现货模拟交易工作台。",
    icons,
    robots: { index: true, follow: true },
  };
  return {
    title: "Riverton Capital",
    description: "Riverton Capital application.",
    icons,
    robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  };
}
