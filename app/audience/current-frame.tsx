import type { AppAudience } from "@/lib/riverton-apps";

/**
 * 按 audience 挂载持久外壳。与 current-root 同样用动态 import，
 * 保证三端各自的构建只打包自己的外壳。
 */
export default async function CurrentFrame({ audience, children }: {
  audience: AppAudience;
  children: React.ReactNode;
}) {
  if (audience === "operations") {
    const { default: OperationsFrame } = await import("@/apps/operations/ui/operations-frame");
    return <OperationsFrame>{children}</OperationsFrame>;
  }
  if (audience === "maintenance") {
    const { default: MaintenanceFrame } = await import("@/apps/maintenance/ui/maintenance-frame");
    return <MaintenanceFrame>{children}</MaintenanceFrame>;
  }
  const { default: ClientFrame } = await import("@/apps/client/ui/client-frame");
  return <ClientFrame>{children}</ClientFrame>;
}
