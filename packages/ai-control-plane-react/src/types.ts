import type {
  AiControlPlaneClient,
  BindingPolicy,
  BudgetPolicy,
  ControlPlaneSnapshot,
  ModelDeployment,
  ProbeReceipt,
  ProviderConnection,
  RoleDescriptor,
} from "@agentnovas/ai-control-plane";
import type { ReactNode } from "react";

export type AiControlPlaneMessages = {
  title: string;
  refresh: string;
  loading: string;
  error: string;
  empty: string;
  connections: string;
  deployments: string;
  bindings: string;
  probes: string;
  budgets: string;
  enabled: string;
  disabled: string;
  primary: string;
  fallback: string;
};

export type AiControlPlaneClassNames = Partial<Record<
  "root" | "header" | "section" | "list" | "item" | "status" | "actions" | "empty" | "error",
  string
>>;

export type AiControlPlaneManagerProps = {
  client: AiControlPlaneClient;
  initialSnapshot?: ControlPlaneSnapshot;
  roles: readonly RoleDescriptor[];
  messages: AiControlPlaneMessages;
  formatDateTime: (value: string) => string;
  classNames?: AiControlPlaneClassNames;
  renderConnectionActions?: (connection: ProviderConnection) => ReactNode;
  renderDeploymentActions?: (deployment: ModelDeployment) => ReactNode;
  renderBindingActions?: (binding: BindingPolicy) => ReactNode;
  renderProbeActions?: (probe: ProbeReceipt) => ReactNode;
  renderBudgetActions?: (budget: BudgetPolicy) => ReactNode;
};
