import "../riverton-console.css";

import ClientPortal from "@/apps/client/ui/client-portal";
import type { CurrentAppProps } from "./current-root";

export default function ClientPortalRoot({ segments, loginMode }: Pick<CurrentAppProps, "segments" | "loginMode">) {
  return <ClientPortal segments={segments} loginMode={loginMode} />;
}
