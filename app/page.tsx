import ClientApp from "@/apps/client/ui/client-app";
import MaintenanceApp from "@/apps/maintenance/ui/maintenance-app";
import OperationsApp from "@/apps/operations/ui/operations-app";
import { resolveAppAudience } from "@/lib/riverton-apps";
import { headers } from "next/headers";

export default async function Page() {
  const audience = resolveAppAudience({ host: (await headers()).get("host") ?? undefined });
  if (audience === "operations") return <OperationsApp segments={[]} />;
  if (audience === "maintenance") return <MaintenanceApp segments={[]} />;
  return <ClientApp />;
}
