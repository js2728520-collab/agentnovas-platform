export type LeaseHeartbeatOptions = {
  leaseSeconds: number;
  intervalMs?: number;
  renew: () => Promise<unknown>;
  onRenewalError?: (error: unknown) => void | Promise<void>;
};

export function startLeaseHeartbeat(input: LeaseHeartbeatOptions) {
  if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) {
    throw new Error("Worker heartbeat leaseSeconds 无效");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const maximumIntervalMs = Math.max(10, Math.floor(input.leaseSeconds * 1_000 / 2));
  const intervalMs = input.intervalMs === undefined
    ? Math.min(maximumIntervalMs, Math.max(1_000, Math.floor(input.leaseSeconds * 1_000 / 3)))
    : Math.min(Math.max(input.intervalMs, 10), maximumIntervalMs);

  const reportRenewalError = async (error: unknown) => {
    try {
      await input.onRenewalError?.(error);
    } catch {
      // Observability hooks must not terminate lease renewal scheduling.
    }
  };
  const tick = () => {
    if (stopped) return;
    inFlight = Promise.resolve()
      .then(input.renew)
      .then(() => undefined, reportRenewalError)
      .finally(() => {
        inFlight = null;
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, intervalMs);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (inFlight) await inFlight;
  };
}
