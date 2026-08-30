# @agentnovas/ai-control-plane-react

Accessible React views and resource state for `@agentnovas/ai-control-plane`. The host injects its client, role catalog,
messages, formatters, permissions/actions, and class names.

```tsx
import { AiControlPlaneManager } from "@agentnovas/ai-control-plane-react";

<AiControlPlaneManager
  client={client}
  roles={roles}
  messages={messages}
  formatDateTime={(value) => new Date(value).toLocaleString()}
/>
```

The package contains no AgentNovas URLs, RBAC keys, translations, global CSS, or brand colors. Use render-action slots to
connect host-specific mutations while retaining the package's semantic lists, headings, loading, error, and empty states.
