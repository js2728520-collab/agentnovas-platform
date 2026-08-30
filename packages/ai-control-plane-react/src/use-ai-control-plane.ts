import type { AiControlPlaneClient, ControlPlaneSnapshot } from "@agentnovas/ai-control-plane";
import { useCallback, useEffect, useState } from "react";

export function useAiControlPlane(client: AiControlPlaneClient, initialSnapshot?: ControlPlaneSnapshot) {
  const [snapshot, setSnapshot] = useState<ControlPlaneSnapshot | null>(initialSnapshot ?? null);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const next = refresh ? await client.refresh() : await client.snapshot();
      setSnapshot(next);
      return next;
    } catch (cause) {
      const nextError = cause instanceof Error ? cause : new Error("AI control plane request failed");
      setError(nextError);
      return null;
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (initialSnapshot) return;

    let active = true;
    client.snapshot().then(
      (next) => {
        if (!active) return;
        setSnapshot(next);
        setError(null);
      },
      (cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause : new Error("AI control plane request failed"));
      },
    ).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [client, initialSnapshot]);

  return { snapshot, loading, error, refresh: () => load(true) };
}
