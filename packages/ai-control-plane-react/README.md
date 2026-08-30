# @agentnovas/ai-control-plane-react

Accessible React views and resource state for `@agentnovas/ai-control-plane`. The host injects its client, role catalog,
messages, formatters, permissions/actions, and class names.

```tsx
import { AiControlPlaneManager, AiUsageManager } from "@agentnovas/ai-control-plane-react";

<AiControlPlaneManager
  client={client}
  roles={roles}
  messages={messages}
  formatDateTime={(value) => new Date(value).toLocaleString()}
  formatRateCard={(rate) => `${rate.inputPerMillion} / ${rate.outputPerMillion} ${rate.currency}`}
  formatProbeDetails={(probe) => [probe.phase ?? "", ...(probe.models ?? [])].filter(Boolean)}
  renderDeploymentRevisionActions={(revision) =>
    revision.isCurrent ? null : <button onClick={() => hostCreatesRollbackRevision(revision)}>Rollback</button>
  }
/>

<AiUsageManager
  client={usageClient}
  query={{ from: "2026-08-01", to: "2026-08-31", includeProbeTraffic: false }}
  messages={usageMessages}
  formatInteger={(value) => String(value)}
/>
```

The package contains no AgentNovas URLs, RBAC keys, translations, notification implementation, global CSS, or brand
colors. The host injects every label and formatter. Use render-action slots to connect host-specific connection,
deployment, immutable revision, binding, probe, and budget mutations while retaining semantic lists, headings, loading,
error, and empty states. `useAiControlPlane` and `useAiUsage` are headless alternatives for hosts that render their own
interface. Newly added snapshot sections and labels remain optional so `0.1.x` hosts can adopt them incrementally.
