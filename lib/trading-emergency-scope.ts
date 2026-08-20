import type { DataScope } from "./rbac.ts";

export type TradingEmergencyScope = {
  scopeKey: string;
  scopeType: "platform" | "organization";
  organizationId: string | null;
};

export function organizationEmergencyScopeKey(organizationId: string) {
  return `organization:${organizationId}`;
}

export function emergencyScopeForAccess(scope: DataScope, organizationId: string | null): TradingEmergencyScope | null {
  if (scope === "PLATFORM") return { scopeKey: "platform", scopeType: "platform", organizationId: null };
  if (!organizationId) return null;
  return { scopeKey: organizationEmergencyScopeKey(organizationId), scopeType: "organization", organizationId };
}
