import type { CurrentAppProps } from "./current-root";

export default async function ClientRoot({ segments, loginMode }: CurrentAppProps) {
  if (segments[0] === "workspace") {
    const { default: ClientWorkspaceRoot } = await import("./client-workspace-root");
    return <ClientWorkspaceRoot />;
  }
  const { default: ClientPortalRoot } = await import("./client-portal-root");
  return <ClientPortalRoot segments={segments} loginMode={loginMode} />;
}
