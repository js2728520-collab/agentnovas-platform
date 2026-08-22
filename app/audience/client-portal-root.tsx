import "../riverton-console.css";

import ClientPortal from "@/apps/client/ui/client-portal";
import { AppLogin } from "@/packages/ui/src/app-login";
import type { CurrentAppProps } from "./current-root";

export default function ClientPortalRoot({ segments, loginMode }: Pick<CurrentAppProps, "segments" | "loginMode">) {
  if (segments[0] === "login") return <AppLogin audience="client" title="Riverton Capital" description="AI 策略研发、回测、模拟盘和会员资产中心。" allowRegistration initialMode={loginMode} />;
  return <ClientPortal segments={segments} />;
}
