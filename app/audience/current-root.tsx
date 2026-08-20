import type { AppAudience } from "@/lib/riverton-apps";

export type CurrentAppProps = {
  audience: AppAudience;
  segments: string[];
  loginMode?: "login" | "register" | "forgot";
};

export default async function CurrentRoot({ audience, segments, loginMode }: CurrentAppProps) {
  if (audience === "operations") {
    const { default: OperationsApp } = await import("./operations-root");
    return <OperationsApp segments={segments} />;
  }
  if (audience === "maintenance") {
    const { default: MaintenanceApp } = await import("./maintenance-root");
    return <MaintenanceApp segments={segments} />;
  }
  const { default: ClientApp } = await import("./client-root");
  return <ClientApp audience={audience} segments={segments} loginMode={loginMode} />;
}
