import { headers } from "next/headers";
import { notFound } from "next/navigation";

import ClientApp from "@/apps/client/ui/client-app";
import ClientPortal from "@/apps/client/ui/client-portal";
import MaintenanceApp from "@/apps/maintenance/ui/maintenance-app";
import OperationsApp from "@/apps/operations/ui/operations-app";
import { resolveAppAudienceStrict } from "@/lib/riverton-apps";

const CLIENT_ROUTES = new Set(["login", "wallet", "notifications"]);
const OPERATIONS_ROUTES = new Set(["login", "customers", "organization", "deposits", "ledger", "finance", "approvals", "access"]);
const MAINTENANCE_ROUTES = new Set(["login", "models", "integrations", "health", "safety", "settings", "access"]);

export async function RivertonRoute({ segments, loginMode }: { segments: string[]; loginMode?: "login" | "register" | "forgot" }) {
  const audience = resolveAppAudienceStrict({ host: (await headers()).get("host") ?? undefined });
  if (!audience) notFound();
  const root = segments[0];
  if (!root) {
    if (audience === "operations") return <OperationsApp segments={[]} />;
    if (audience === "maintenance") return <MaintenanceApp segments={[]} />;
    return <ClientApp />;
  }
  if (audience === "client" && CLIENT_ROUTES.has(root)) {
    if (root === "wallet" && segments[1] && segments[1] !== "deposits") notFound();
    if (root !== "wallet" && segments.length > 1) notFound();
    if (segments.length > 2) notFound();
    return <ClientPortal segments={segments} loginMode={loginMode} />;
  }
  if (audience === "operations" && OPERATIONS_ROUTES.has(root)) {
    if (root === "deposits" && segments.length > 2) notFound();
    if (root === "access" && segments[1] && segments[1] !== "audit") notFound();
    if (!["deposits", "access"].includes(root) && segments.length > 1) notFound();
    return <OperationsApp segments={segments} />;
  }
  if (audience === "maintenance" && MAINTENANCE_ROUTES.has(root)) {
    if (root === "integrations" && segments[1] && !["email", "payments"].includes(segments[1])) notFound();
    if (root === "access" && segments[1] && segments[1] !== "audit") notFound();
    if (!["integrations", "access"].includes(root) && segments.length > 1) notFound();
    return <MaintenanceApp segments={segments} />;
  }
  notFound();
}
