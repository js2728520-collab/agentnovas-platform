import type { CurrentAppProps } from "./current-root";

export default async function ClientRoot({ segments, loginMode }: CurrentAppProps) {
  const { default: ClientPortalRoot } = await import("./client-portal-root");
  return <ClientPortalRoot segments={segments} loginMode={loginMode} />;
}
