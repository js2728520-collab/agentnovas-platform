import type { Pool } from "pg";

export const MAINTENANCE_QUEUE_THRESHOLDS = Object.freeze({
  notification_email: { warningAgeSeconds: 120, criticalAgeSeconds: 300 },
  demo_execution: { warningAgeSeconds: 60, criticalAgeSeconds: 180 },
  research: { warningAgeSeconds: 120, criticalAgeSeconds: 300 },
  membership_review: { warningAgeSeconds: 3_600, criticalAgeSeconds: 14_400 },
  performance_review: { warningAgeSeconds: 3_600, criticalAgeSeconds: 14_400 },
});

export type MaintenanceQueueName = keyof typeof MAINTENANCE_QUEUE_THRESHOLDS;

export function evaluateMaintenanceQueue(input: {
  queue: MaintenanceQueueName;
  depth: number;
  oldestAgeSeconds: number | null;
}) {
  const threshold = MAINTENANCE_QUEUE_THRESHOLDS[input.queue];
  const depth = Number.isSafeInteger(input.depth) && input.depth >= 0 ? input.depth : 0;
  const oldestAgeSeconds = input.oldestAgeSeconds === null
    ? null
    : Math.max(0, Math.round(input.oldestAgeSeconds));
  const status = depth === 0 ? "healthy"
    : oldestAgeSeconds !== null && oldestAgeSeconds >= threshold.criticalAgeSeconds ? "critical"
      : oldestAgeSeconds !== null && oldestAgeSeconds >= threshold.warningAgeSeconds ? "warning"
        : "healthy";
  return { queue: input.queue, depth, oldestAgeSeconds, status, ...threshold };
}

export async function loadMaintenanceHealthMetrics(pool: Pick<Pool, "query">, now = new Date()) {
  const result = await pool.query<{
    queue: MaintenanceQueueName;
    depth: string;
    oldest_age_seconds: string | null;
  }>(`
    SELECT 'notification_email'::text AS queue,count(*)::text AS depth,
           extract(epoch FROM ($1::timestamptz-min(scheduled_at::timestamptz)))::text AS oldest_age_seconds
      FROM notification_deliveries WHERE channel='email' AND status='queued'
    UNION ALL
    SELECT 'demo_execution',count(*)::text,
           extract(epoch FROM ($1::timestamptz-min(next_attempt_at)))::text
      FROM platform_demo_order_intents WHERE status IN ('pending','retry_wait','unknown','reconcile_wait')
    UNION ALL
    SELECT 'research',count(*)::text,
           extract(epoch FROM ($1::timestamptz-min(coalesce(next_attempt_at,created_at))))::text
      FROM strategy_research_runs WHERE status IN ('queued','retry_wait')
    UNION ALL
    SELECT 'membership_review',count(*)::text,
           extract(epoch FROM ($1::timestamptz-min(created_at)))::text
      FROM commercial_membership_orders WHERE status='pending_review'
    UNION ALL
    SELECT 'performance_review',count(*)::text,
           extract(epoch FROM ($1::timestamptz-min(created_at)))::text
      FROM performance_fee_statements WHERE status IN ('pending_review','payment_pending')
  `, [now.toISOString()]);
  return result.rows.map((row) => evaluateMaintenanceQueue({
    queue: row.queue,
    depth: Number(row.depth),
    oldestAgeSeconds: row.oldest_age_seconds === null ? null : Number(row.oldest_age_seconds),
  }));
}
