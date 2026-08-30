# @agentnovas/ai-control-plane

Framework-independent contracts and pure state derivation for provider connections, model deployments, role bindings,
probe health, invocation fallback, usage, and soft budgets.

```ts
import {
  AI_ROLE_CATALOG,
  assertBindingPolicy,
  calculateProviderCost,
  createInvocationOrchestrator,
  resolveBindingPlan,
} from "@agentnovas/ai-control-plane";

const policy = assertBindingPolicy({
  id: "assistant",
  revisionId: "assistant-r1",
  roleKey: "client.assistant_message",
  enabled: true,
  targets: [{ deploymentId: "fast-model", priority: 0 }],
});

const providerCost = calculateProviderCost({
  currency: "USD",
  inputPerMillion: "2.50",
  outputPerMillion: "10.00",
  usage: { inputTokens: 1_200, outputTokens: 300 },
});
```

The package performs no database, network, filesystem, environment-variable, or framework I/O. Hosts implement the
exported ports, including `ControlPlaneRepository`, `InvocationGateway`, `UsageSink`, `AiControlPlaneClient`, and
`AiUsageClient`. OpenAI-compatible payload handling uses an injected transport.

The public resources separate provider connections, immutable deployment revisions, role bindings, probe receipts,
invocation receipts, usage events, rate cards, and soft budgets. `createInvocationOrchestrator` pins resolved revision
snapshots and falls back only for network errors, timeouts, rate limits, and provider 5xx failures. Exact provider cost
calculation uses decimal strings and `bigint`; no IEEE-754 amount arithmetic or fabricated price is used.

Hosts own endpoint policy, secret custody, persistence, authentication, authorization, localization, and telemetry. The
package never reads environment variables or secret values and does not know AgentNovas routes or roles beyond the fixed
twelve-role product catalog.

Version `0.1.x` is an internal preview contract. It is packable for trusted projects but is not published by this repository.
