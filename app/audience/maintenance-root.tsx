import "../riverton-console.css";

import MaintenanceApp from "@/apps/maintenance/ui/maintenance-app";
import { AppLogin } from "@/packages/ui/src/app-login";
import type { CurrentAppProps } from "./current-root";

export default function MaintenanceRoot({ segments }: Pick<CurrentAppProps, "segments">) {
  if (segments[0] === "login") return <AppLogin audience="maintenance" title="Riverton 运维端" description="模型、集成、安全、审计和系统健康工作台。" allowRegistration={false} />;
  return <MaintenanceApp segments={segments} />;
}
