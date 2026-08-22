import "../riverton-console.css";

import OperationsApp from "@/apps/operations/ui/operations-app";
import { AppLogin } from "@/packages/ui/src/app-login";
import type { CurrentAppProps } from "./current-root";

export default function OperationsRoot({ segments }: Pick<CurrentAppProps, "segments">) {
  if (segments[0] === "login") return <AppLogin audience="operations" title="Riverton 运营端" description="客户、充值、账务、财务和审批工作台。" allowRegistration={false} />;
  return <OperationsApp segments={segments} />;
}
