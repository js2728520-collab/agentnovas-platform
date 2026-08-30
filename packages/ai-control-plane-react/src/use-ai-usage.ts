import type { AiUsageClient,UsageSnapshot } from "@agentnovas/ai-control-plane";
import { useCallback,useEffect,useState } from "react";

export type AiUsageQuery = { from: string;to: string;includeProbeTraffic: boolean };

export function useAiUsage(client: AiUsageClient,query: AiUsageQuery,initialSnapshot?: UsageSnapshot) {
  const [snapshot,setSnapshot] = useState<UsageSnapshot | null>(initialSnapshot ?? null);
  const [loading,setLoading] = useState(!initialSnapshot);
  const [error,setError] = useState<Error | null>(null);
  const { from,to,includeProbeTraffic } = query;
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const next = await client.snapshot({ from,to,includeProbeTraffic });
      setSnapshot(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("AI usage request failed"));
      return null;
    } finally {
      setLoading(false);
    }
  },[client,from,to,includeProbeTraffic]);
  useEffect(() => {
    if (initialSnapshot) return;
    let active = true;
    client.snapshot({ from,to,includeProbeTraffic }).then(
      (next) => {
        if (!active) return;
        setSnapshot(next);
        setError(null);
      },
      (cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause : new Error("AI usage request failed"));
      },
    ).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  },[client,from,to,includeProbeTraffic,initialSnapshot]);
  return { snapshot,loading,error,refresh: load };
}
