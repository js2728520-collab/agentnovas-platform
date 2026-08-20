import "../globals.css";
import "../market-terminal.css";
import "../membership-center.css";
import "../riverton-console.css";

import ClientApp from "@/apps/client/ui/client-app";
import ClientPortal from "@/apps/client/ui/client-portal";
import type { CurrentAppProps } from "./current-root";
import LocaleGuard from "../locale-guard";

export default function ClientRoot({ segments, loginMode }: CurrentAppProps) {
  return <><LocaleGuard />{segments.length
    ? <ClientPortal segments={segments} loginMode={loginMode} />
    : <ClientApp />}</>;
}
