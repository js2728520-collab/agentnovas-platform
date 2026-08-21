import { ResearchApiError } from "./research-errors.ts";

export const RELEASE_CHANNELS = ["beta", "stable"] as const;
export const RELEASE_ENVIRONMENTS = ["staging", "production"] as const;
export const RELEASE_DECISIONS = ["approve", "reject"] as const;
export const RELEASE_DEPLOYMENT_ACTIONS = ["deploy", "rollback"] as const;
export const RELEASE_DEPLOYMENT_STATUSES = ["succeeded", "failed"] as const;

export type ReleaseChannel = typeof RELEASE_CHANNELS[number];
export type ReleaseEnvironment = typeof RELEASE_ENVIRONMENTS[number];
export type ReleaseDecision = typeof RELEASE_DECISIONS[number];
export type ReleaseDeploymentAction = typeof RELEASE_DEPLOYMENT_ACTIONS[number];
export type ReleaseDeploymentStatus = typeof RELEASE_DEPLOYMENT_STATUSES[number];
export type ReleaseVersionStatus = "draft" | "verified" | "rejected" | "deployed" | "superseded" | "rolled_back";

export type NormalizedReleaseRegistration = {
  versionTag: string;
  channel: ReleaseChannel;
  commitSha: string;
  artifactSha256: string;
  migrationVersion: string;
  releaseNotes: string;
  reason: string;
};

export type NormalizedReleaseVerification = {
  decision: ReleaseDecision;
  evidenceSha256: string;
  ciRunUrl?: string;
  reason: string;
};

export type NormalizedReleaseDeployment = {
  environment: ReleaseEnvironment;
  action: ReleaseDeploymentAction;
  status: ReleaseDeploymentStatus;
  evidenceSha256: string;
  reason: string;
};

const SEMVER = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIGRATION_VERSION = /^\d{4}_[a-z0-9_]{3,96}$/;

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchApiError("RELEASE_INPUT_INVALID", "版本管理请求必须是对象", 422);
  }
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ResearchApiError("RELEASE_INPUT_UNKNOWN_FIELDS", "版本管理请求包含不允许的字段", 422, { fields: extra });
}

function text(value: unknown, label: string, minimum: number, maximum: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ResearchApiError("RELEASE_INPUT_INVALID", `${label}长度必须为 ${minimum}–${maximum} 个字符`, 422);
  }
  return normalized;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ResearchApiError("RELEASE_INPUT_INVALID", `${label}无效`, 422);
  }
  return value as T;
}

function lowerHash(value: unknown, pattern: RegExp, label: string) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!pattern.test(normalized)) throw new ResearchApiError("RELEASE_INPUT_INVALID", `${label}无效`, 422);
  return normalized;
}

export function normalizeReleaseRegistration(input: unknown): NormalizedReleaseRegistration {
  const value = object(input);
  strictKeys(value, ["versionTag", "channel", "commitSha", "artifactSha256", "migrationVersion", "releaseNotes", "reason"]);
  const versionTag = typeof value.versionTag === "string" ? value.versionTag.trim() : "";
  if (!SEMVER.test(versionTag)) throw new ResearchApiError("RELEASE_VERSION_TAG_INVALID", "版本标签必须是以 v 开头的有效 SemVer", 422);
  const migrationVersion = typeof value.migrationVersion === "string" ? value.migrationVersion.trim() : "";
  if (!MIGRATION_VERSION.test(migrationVersion)) throw new ResearchApiError("RELEASE_MIGRATION_VERSION_INVALID", "迁移版本格式无效", 422);
  return {
    versionTag,
    channel: oneOf(value.channel, RELEASE_CHANNELS, "发布通道"),
    commitSha: lowerHash(value.commitSha, COMMIT_SHA, "commit SHA"),
    artifactSha256: lowerHash(value.artifactSha256, SHA256, "构建产物 SHA-256"),
    migrationVersion,
    releaseNotes: text(value.releaseNotes, "发布说明", 10, 10_000),
    reason: text(value.reason, "登记原因", 8, 500),
  };
}

function safeCiRunUrl(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = text(value, "CI 运行地址", 1, 500);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password
      || !/^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/?$/.test(parsed.pathname)) throw new Error("unsafe");
    return parsed.toString();
  } catch {
    throw new ResearchApiError("RELEASE_CI_RUN_URL_INVALID", "CI 运行地址必须是 GitHub Actions 的 HTTPS run URL", 422);
  }
}

export function normalizeReleaseVerification(input: unknown): NormalizedReleaseVerification {
  const value = object(input);
  strictKeys(value, ["decision", "evidenceSha256", "ciRunUrl", "reason"]);
  return {
    decision: oneOf(value.decision, RELEASE_DECISIONS, "复核决定"),
    evidenceSha256: lowerHash(value.evidenceSha256, SHA256, "验证证据 SHA-256"),
    ciRunUrl: safeCiRunUrl(value.ciRunUrl),
    reason: text(value.reason, "复核原因", 8, 500),
  };
}

export function normalizeReleaseDeployment(input: unknown): NormalizedReleaseDeployment {
  const value = object(input);
  strictKeys(value, ["environment", "action", "status", "evidenceSha256", "reason"]);
  return {
    environment: oneOf(value.environment, RELEASE_ENVIRONMENTS, "环境"),
    action: oneOf(value.action, RELEASE_DEPLOYMENT_ACTIONS, "部署操作"),
    status: oneOf(value.status, RELEASE_DEPLOYMENT_STATUSES, "部署结果"),
    evidenceSha256: lowerHash(value.evidenceSha256, SHA256, "部署证据 SHA-256"),
    reason: text(value.reason, "部署原因", 8, 500),
  };
}

export function safeRuntimeReleaseMetadata(environment: Record<string, string | undefined>) {
  const versionTag = environment.RIVERTON_RELEASE_TAG?.trim() ?? "";
  const commitSha = (environment.GIT_COMMIT_SHA ?? environment.RIVERTON_COMMIT_SHA)?.trim().toLowerCase() ?? "";
  const artifactSha256 = environment.RIVERTON_ARTIFACT_SHA256?.trim().toLowerCase() ?? "";
  return {
    versionTag: SEMVER.test(versionTag) ? versionTag : null,
    commitSha: COMMIT_SHA.test(commitSha) ? commitSha : null,
    artifactSha256: SHA256.test(artifactSha256) ? artifactSha256 : null,
  };
}
