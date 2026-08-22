import "../riverton-console.css";
// 遗留样式：/assistant、/trading-hall 与决策会议室是从 /workspace 迁过来的，
// 它们的 agent-chat-* / hall-* / meeting-* 类名只在 globals-beta.css 里有定义。
// P4 第 2、3 步只搬了组件没搬样式，导致这两个页面直到本次修复前都是无样式的。
//
// 这是**临时**恢复：正确做法是把这批规则（约 515 条、61KB、其中 184 条含硬编码
// 色值）转成 --rv-* 令牌驱动的 CSS Module，与 strategy-studio.module.css 一致。
// 在那之前保留这行，并在 CLAUDE.md 的遗留表里记着。
import "../globals-beta.css";

import ClientPortal from "@/apps/client/ui/client-portal";
import { AppLogin } from "@/packages/ui/src/app-login";
import type { CurrentAppProps } from "./current-root";

export default function ClientPortalRoot({ segments, loginMode }: Pick<CurrentAppProps, "segments" | "loginMode">) {
  if (segments[0] === "login") return <AppLogin audience="client" title="Riverton Capital" description="AI 策略研发、回测、模拟盘和会员资产中心。" allowRegistration initialMode={loginMode} />;
  return <ClientPortal segments={segments} />;
}
