import { AI_ROLE_CATALOG } from "./roles.ts";
import type {
  BindingCandidate,
  BindingPolicy,
  ConnectionRevision,
  ModelDeployment,
  ProviderFailure,
} from "./types.ts";

const roleKeys = new Set(AI_ROLE_CATALOG.map((role) => role.key));

export function assertBindingPolicy(input: BindingPolicy): BindingPolicy {
  if (!roleKeys.has(input.roleKey)) throw new Error("binding role is not supported");
  if (!input.id.trim() || !input.revisionId.trim()) throw new Error("binding identity is required");
  if (input.targets.length < 1 || input.targets.length > 3) {
    throw new Error("binding policy must contain at most three targets");
  }
  const deployments = new Set<string>();
  input.targets.forEach((target, index) => {
    if (!target.deploymentId.trim()) throw new Error("binding deployment is required");
    if (target.priority !== index) throw new Error("binding target priority must start at zero and be contiguous");
    if (deployments.has(target.deploymentId)) throw new Error("binding deployments must be unique");
    deployments.add(target.deploymentId);
  });
  return Object.freeze({ ...input, targets: Object.freeze(input.targets.map((target) => Object.freeze({ ...target }))) });
}

export function isRetryableProviderFailure(failure: Pick<ProviderFailure, "code">) {
  return failure.code === "network"
    || failure.code === "timeout"
    || failure.code === "rate_limited"
    || failure.code === "provider_5xx";
}

export function resolveBindingPlan(input: {
  policy: BindingPolicy;
  deployments: readonly ModelDeployment[];
  connectionRevisions: readonly ConnectionRevision[];
}): BindingCandidate[] {
  const policy = assertBindingPolicy(input.policy);
  if (!policy.enabled) return [];
  const deployments = new Map(input.deployments.map((deployment) => [deployment.id, deployment]));
  const revisions = new Map(input.connectionRevisions.map((revision) => [revision.connectionId, revision]));
  return policy.targets.flatMap((target): BindingCandidate[] => {
    const deployment = deployments.get(target.deploymentId);
    if (!deployment?.enabled || !deployment.currentRevisionId) return [];
    const connection = revisions.get(deployment.connectionId);
    if (!connection?.enabled || !connection.secretRef) return [];
    return [{
      fallbackRank: target.priority,
      policyRevisionId: policy.revisionId,
      deploymentId: deployment.id,
      deploymentRevisionId: deployment.currentRevisionId,
      connectionId: deployment.connectionId,
      connectionRevisionId: connection.id,
      secretRef: connection.secretRef,
    }];
  });
}
