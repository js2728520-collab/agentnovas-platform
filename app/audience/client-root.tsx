import type { CurrentAppProps } from "./current-root";

export default async function ClientRoot({ segments, loginMode }: CurrentAppProps) {
  if (segments.length === 0) {
    const { default: ClientLandingRoot } = await import("./client-landing-root");
    return <ClientLandingRoot />;
  }
  const { default: ClientPortalRoot } = await import("./client-portal-root");
  return <ClientPortalRoot segments={segments} loginMode={loginMode} />;
}
