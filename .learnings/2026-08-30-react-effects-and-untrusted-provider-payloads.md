# Learning: React effects and untrusted provider payloads need explicit boundaries

**Date**: 2026-08-30
**Type**: error
**Agent**: ben

## Context

The reusable AI control-plane packages failed targeted ESLint checks after their first green functional test run.

## Problem/Issue

The initial-load effect called a helper that synchronously changed React state before starting its request, triggering `react-hooks/set-state-in-effect`. The OpenAI-compatible adapter also cast an untrusted provider response to `Record<string, any>`, bypassing the package's type boundary.

The package build targeted ES2022, but the host application's whole-repository TypeScript check targets ES2017. BigInt literal syntax therefore passed package compilation and failed host compilation.

## Solution

The effect now starts the snapshot promise directly and updates state only from settled promise callbacks, with an `active` guard for unmounts. The provider response now narrows `unknown` to a small structural payload type whose leaf values remain `unknown` until validated.

Exact budget arithmetic keeps using `BigInt`, but uses constructor calls rather than BigInt literal syntax so the reusable package also type-checks when consumed by the ES2017-targeted host.

## Key Insights

- Event-driven refresh helpers may set loading state synchronously, but mount effects should subscribe to asynchronous work and update state from completion callbacks.
- Provider JSON is an untrusted boundary; describe only the fields consumed and validate numeric leaves instead of spreading `any` through the adapter.
- Targeted lint commands must ignore generated `dist` files just as the root lint configuration does.
- A reusable package must pass both its own compiler target and the host repository's compiler target.

## Prevention

Run package lint before committing the first implementation slice, keep transport responses typed as `unknown`, and include effect cleanup in every externally loaded hook.

## See Also

- `packages/ai-control-plane-react/src/use-ai-control-plane.ts`
- `packages/ai-control-plane/src/provider.ts`
- `test-driven-development`
- `self-improving-agent`
