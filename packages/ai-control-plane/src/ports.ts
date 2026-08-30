import type {
  BindingPolicy,
  BudgetPolicy,
  InvocationReceipt,
  ModelDeployment,
  DeploymentRevision,
  ProbeReceipt,
  ProviderConnection,
  UsageEvent,
  UsageSnapshot,
} from "./types.ts";

export type ControlPlaneSnapshot = {
  connections: readonly ProviderConnection[];
  deployments: readonly ModelDeployment[];
  deploymentRevisions?: readonly DeploymentRevision[];
  bindings: readonly BindingPolicy[];
  probes: readonly ProbeReceipt[];
  budgets: readonly BudgetPolicy[];
};

export interface EndpointPolicy {
  assertAllowed(endpoint: string): Promise<{ endpoint: string; pinnedAddresses?: readonly string[] }>;
}

export interface SecretStorePort {
  has(secretRef: string): Promise<boolean>;
  read(secretRef: string): Promise<string>;
}

export interface ControlPlaneRepository {
  snapshot(): Promise<ControlPlaneSnapshot>;
  readInvocation(invocationId: string): Promise<InvocationReceipt | null>;
  saveInvocation(receipt: InvocationReceipt): Promise<void>;
}

export interface InvocationGateway {
  invoke(input: { invocationId: string; requestHash: string; roleKey: string; payload: unknown }): Promise<InvocationReceipt>;
  cancel(invocationId: string): Promise<{ cancelled: boolean }>;
}

export interface UsageSink {
  append(event: UsageEvent): Promise<void>;
}

export interface AiUsageClient {
  snapshot(query: { from: string; to: string; includeProbeTraffic: boolean }): Promise<UsageSnapshot>;
}

export interface AiControlPlaneClient {
  snapshot(): Promise<ControlPlaneSnapshot>;
  refresh(): Promise<ControlPlaneSnapshot>;
}
