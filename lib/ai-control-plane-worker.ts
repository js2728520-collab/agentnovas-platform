import type { Pool,PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient,"query">;

/** Reads only the redacted label for a revision already pinned into a durable task. */
export async function resolveWorkerModelName(database: Queryable,deploymentRevisionId: string) {
  const row = (await database.query<{ model_id: string }>(`
    SELECT model_id FROM worker_ai_deployment_revisions_safe WHERE deployment_revision_id=$1
  `,[deploymentRevisionId])).rows[0];
  return row?.model_id ?? null;
}
