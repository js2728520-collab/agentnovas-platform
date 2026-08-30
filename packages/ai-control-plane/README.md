# @agentnovas/ai-control-plane

Framework-independent contracts and pure state derivation for provider connections, model deployments, role bindings,
probe health, invocation fallback, usage, and soft budgets.

```ts
import { AI_ROLE_CATALOG, assertBindingPolicy, resolveBindingPlan } from "@agentnovas/ai-control-plane";

const policy = assertBindingPolicy({
  id: "assistant",
  revisionId: "assistant-r1",
  roleKey: "client.assistant_message",
  enabled: true,
  targets: [{ deploymentId: "fast-model", priority: 0 }],
});
```

The package performs no database, network, filesystem, environment-variable, or framework I/O. Hosts implement the
exported ports. OpenAI-compatible payload handling uses an injected transport.

Version `0.1.x` is an internal preview contract. It is packable for trusted projects but is not published by this repository.
