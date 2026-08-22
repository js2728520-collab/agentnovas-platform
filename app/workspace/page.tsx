import { headers } from "next/headers";
import { notFound } from "next/navigation";

import ClientWorkspaceRoot from "@/app/audience/client-workspace-root";
import { resolveAppAudienceStrict } from "@/lib/riverton-apps";

export default async function ClientWorkspacePage() {
  const audience = resolveAppAudienceStrict({ host: (await headers()).get("host") ?? undefined });
  if (audience !== "client") notFound();
  return <ClientWorkspaceRoot />;
}
