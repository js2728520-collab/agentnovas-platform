import "../globals-beta.css";
import "../market-terminal.css";
import "../membership-center.css";

import ClientWorkspaceLoader from "@/apps/client/ui/client-workspace-loader";
import LocaleGuard from "../locale-guard";

export default function ClientWorkspaceRoot() {
  return <><LocaleGuard /><ClientWorkspaceLoader /></>;
}
