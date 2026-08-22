import type {
  ReleaseChannel,
  ReleaseDecision,
  ReleaseDeploymentAction,
  ReleaseDeploymentStatus,
  ReleaseEnvironment,
  ReleaseVersionStatus,
} from "../../../lib/release-version-domain.ts";

export type ReleaseVerification = {
  id: string;
  decision: ReleaseDecision;
  evidenceSha256: string;
  ciRunUrl: string | null;
  reviewerUserId: string;
  reason: string;
  createdAt: string;
};
export type ReleaseDeployment = {
  id: string;
  environment: ReleaseEnvironment;
  action: ReleaseDeploymentAction;
  status: ReleaseDeploymentStatus;
  previousReleaseVersionId: string | null;
  evidenceSha256: string;
  actorUserId: string;
  reason: string;
  createdAt: string;
};

export type ReleaseVersion = {
  id: string;
  versionTag: string;
  channel: ReleaseChannel;
  commitSha: string;
  artifactSha256: string;
  migrationVersion: string;
  releaseNotes: string;
  createdByUserId: string;
  reason: string;
  createdAt: string;
  status: ReleaseVersionStatus;
  verification: ReleaseVerification | null;
  deployments: ReleaseDeployment[];
  currentEnvironments: ReleaseEnvironment[];
};

export type ReleaseManagementPayload = {
  runtime: { versionTag: string | null; commitSha: string | null; artifactSha256: string | null };
  releases: ReleaseVersion[];
  currentByEnvironment: Record<ReleaseEnvironment, Pick<ReleaseVersion, "id" | "versionTag" | "commitSha"> | null>;
  nextCursor: string | null;
};
