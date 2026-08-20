import { ResearchApiError } from "./research-errors.ts";
import type { DataScope } from "./rbac.ts";

export type AccessActor = { id: string; organizationId: string | null };
export type AccessSubject = { id: string; organizationId: string | null; reportsToUserId: string | null };

const scopeRank: Record<DataScope, number> = {
  SELF: 0,
  DIRECT_REPORTS: 1,
  TEAM_TREE: 2,
  ORGANIZATION: 3,
  ORGANIZATION_SET: 4,
  PLATFORM: 5,
};

function effectiveOrganizationIds(actor: AccessActor, organizationIds: readonly string[]) {
  return organizationIds.length ? [...new Set(organizationIds)] : actor.organizationId ? [actor.organizationId] : [];
}

export function scopeCanDelegate(granted: DataScope, requested: DataScope) {
  return scopeRank[requested] <= scopeRank[granted];
}

export function canAccessInternalUser(
  scope: DataScope,
  actor: AccessActor,
  target: AccessSubject,
  people: readonly AccessSubject[],
  organizationIds: readonly string[] = [],
) {
  if (scope === "PLATFORM") return true;
  if (target.id === actor.id) return true;
  if (scope === "SELF") return false;
  if (scope === "DIRECT_REPORTS") return target.reportsToUserId === actor.id;
  if (scope === "ORGANIZATION" || scope === "ORGANIZATION_SET") {
    return Boolean(target.organizationId) && effectiveOrganizationIds(actor, organizationIds).includes(target.organizationId!);
  }
  const peopleById = new Map(people.map((person) => [person.id, person]));
  let current: AccessSubject | undefined = target;
  const seen = new Set<string>();
  for (let depth = 0; current?.reportsToUserId && depth < 32; depth += 1) {
    if (current.reportsToUserId === actor.id) return true;
    if (seen.has(current.reportsToUserId)) return false;
    seen.add(current.reportsToUserId);
    current = peopleById.get(current.reportsToUserId);
  }
  return false;
}

export function accessUserScopePredicate(input: {
  scope: DataScope;
  actor: AccessActor;
  organizationIds: readonly string[];
  userAlias: string;
  startIndex: number;
}) {
  if (!/^[a-z][a-z0-9_]*$/i.test(input.userAlias)) throw new Error("Invalid SQL alias");
  if (input.scope === "PLATFORM") return { clause: "TRUE", values: [] as unknown[] };
  const actorIndex = input.startIndex;
  if (input.scope === "SELF") {
    return { clause: `${input.userAlias}.id = $${actorIndex}`, values: [input.actor.id] as unknown[] };
  }
  if (input.scope === "DIRECT_REPORTS") {
    return {
      clause: `(${input.userAlias}.id = $${actorIndex} OR ${input.userAlias}.reports_to_user_id = $${actorIndex})`,
      values: [input.actor.id] as unknown[],
    };
  }
  if (input.scope === "ORGANIZATION" || input.scope === "ORGANIZATION_SET") {
    const organizationIds = effectiveOrganizationIds(input.actor, input.organizationIds);
    if (!organizationIds.length) return { clause: "FALSE", values: [] as unknown[] };
    return {
      clause: `${input.userAlias}.organization_id = ANY($${actorIndex}::text[])`,
      values: [organizationIds] as unknown[],
    };
  }
  return {
    clause: `EXISTS (
      WITH RECURSIVE access_ancestors AS (
        SELECT ${input.userAlias}.id, ${input.userAlias}.reports_to_user_id, 0 AS depth
        UNION ALL
        SELECT parent.id, parent.reports_to_user_id, access_ancestors.depth + 1
        FROM users AS parent
        INNER JOIN access_ancestors ON parent.id = access_ancestors.reports_to_user_id
        WHERE access_ancestors.depth < 32
      )
      SELECT 1 FROM access_ancestors WHERE id = $${actorIndex}
    )`,
    values: [input.actor.id] as unknown[],
  };
}

export function accessOrganizationResourcePredicate(input: {
  scope: DataScope;
  actor: AccessActor;
  organizationIds: readonly string[];
  columns: readonly string[];
  startIndex: number;
}) {
  if (!input.columns.length || input.columns.some((column) => !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/i.test(column))) {
    throw new Error("Invalid SQL organization column");
  }
  if (input.scope === "PLATFORM") return { clause: "TRUE", values: [] as unknown[] };
  const organizationIds = effectiveOrganizationIds(input.actor, input.organizationIds);
  if (!organizationIds.length) {
    return {
      clause: input.columns.map((column) => `${column} IS NULL`).join(" AND "),
      values: [] as unknown[],
    };
  }
  return {
    clause: input.columns
      .map((column) => `(${column} IS NULL OR ${column} = ANY($${input.startIndex}::text[]))`)
      .join(" AND "),
    values: [organizationIds] as unknown[],
  };
}

export type AccessPagePosition = { createdAt: string; id: string };

export function accessPageCursor(position: AccessPagePosition) {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

export function parseAccessPageCursor(cursor: string | null | undefined): AccessPagePosition | null {
  if (!cursor) return null;
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ResearchApiError("VALIDATION_ERROR", "分页游标无效", 422, { fields: ["cursor"] });
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    const createdAt = String(parsed.createdAt ?? "");
    const id = String(parsed.id ?? "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(createdAt) || !id || id.length > 160) throw new Error("invalid cursor");
    return { createdAt: new Date(createdAt).toISOString(), id };
  } catch (error) {
    if (error instanceof ResearchApiError) throw error;
    throw new ResearchApiError("VALIDATION_ERROR", "分页游标无效", 422, { fields: ["cursor"] });
  }
}
