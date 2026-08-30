# Learning: WebCrypto buffers and persisted terminal states need explicit narrowing

**Date**: 2026-08-30
**Type**: error
**Agent**: ben

## Context

The Secret Broker and PostgreSQL-backed Gateway passed runtime tests before the repository-wide TypeScript check ran.

## Problem/Issue

Node's `Uint8Array` can be parameterized with `ArrayBufferLike`, while WebCrypto's `importKey` overload requires an `ArrayBuffer`-backed source. Separately, checking a persisted status with `Set.has` did not narrow the row's union to the three public terminal receipt states.

## Solution

The Broker passes the known decrypt-result `ArrayBuffer` explicitly to WebCrypto. The Gateway repository derives a `terminalStatus` through direct equality branches before constructing a public receipt.

## Key Insights

- A passing Node WebCrypto runtime call can still violate DOM/WebCrypto TypeScript overloads in a mixed Node/DOM project.
- Generic collection membership does not provide discriminated-union narrowing; public state transitions should be made explicit.
- Database rows often represent a wider lifecycle than the API object returned to callers.

## Prevention

Run the host TypeScript compiler after crypto and persistence slices, and convert persisted lifecycle states through explicit boundary functions before returning public types.

## See Also

- `lib/ai-secret-broker.ts`
- `lib/ai-gateway-repository.ts`
- `packages/ai-control-plane/src/types.ts`
