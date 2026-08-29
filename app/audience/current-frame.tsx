import type { AppAudience } from "@/lib/riverton-apps";
import type { UserAppLocale } from "@/lib/user-app-preference";
import { AppLocaleProvider } from "@/packages/ui/src/app-locale-context";

/**
 * 按 audience 挂载持久外壳。与 current-root 同样用动态 import，
 * 保证三端各自的构建只打包自己的外壳。
 */
export default async function CurrentFrame({ audience, initialLocale, children }: {
  audience: AppAudience;
  initialLocale: UserAppLocale;
  children: React.ReactNode;
}) {
  let frame: React.ReactNode;
  if (audience === "operations") {
    const { default: OperationsFrame } = await import("@/apps/operations/ui/operations-frame");
    frame = <OperationsFrame>{children}</OperationsFrame>;
  } else if (audience === "maintenance") {
    const { default: MaintenanceFrame } = await import("@/apps/maintenance/ui/maintenance-frame");
    frame = <MaintenanceFrame>{children}</MaintenanceFrame>;
  } else {
    const { default: ClientFrame } = await import("@/apps/client/ui/client-frame");
    frame = <ClientFrame>{children}</ClientFrame>;
  }
  return <AppLocaleProvider audience={audience} initialLocale={initialLocale}>{frame}</AppLocaleProvider>;
}
