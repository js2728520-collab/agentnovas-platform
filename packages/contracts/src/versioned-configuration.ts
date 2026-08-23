import type {
  ConfigurationActivationAction,
  ConfigurationApprovalDecision,
  ConfigurationAudience,
  ConfigurationKind,
  ConfigurationTestResult,
  ConfigurationVersionStatus,
} from "../../../lib/versioned-configuration-domain.ts";

export type ConfigurationTestFact = {
  id: string;
  result: ConfigurationTestResult;
  evidenceSha256: string;
  testedByUserId: string;
  reason: string;
  createdAt: string;
};

export type ConfigurationApprovalFact = {
  id: string;
  decision: ConfigurationApprovalDecision;
  reviewerUserId: string;
  reason: string;
  createdAt: string;
};

export type ConfigurationScheduleFact = {
  id: string;
  scheduledFor: string;
  scheduledByUserId: string;
  reason: string;
  createdAt: string;
};

export type ConfigurationActivationFact = {
  id: string;
  action: ConfigurationActivationAction;
  previousConfigurationVersionId: string | null;
  actorUserId: string | null;
  actorKind: "user" | "worker";
  actorIdentity: string | null;
  reason: string;
  createdAt: string;
};

export type ConfigurationVersion = {
  id: string;
  kind: ConfigurationKind;
  key: string;
  audience: ConfigurationAudience;
  versionNumber: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
  payloadSha256: string;
  createdByUserId: string;
  reason: string;
  createdAt: string;
  status: ConfigurationVersionStatus;
  isCurrent: boolean;
  latestTest: ConfigurationTestFact | null;
  approval: ConfigurationApprovalFact | null;
  schedule: ConfigurationScheduleFact | null;
  activations: ConfigurationActivationFact[];
};

export type ConfigurationVersionsPayload = {
  versions: ConfigurationVersion[];
  nextCursor: string | null;
};
