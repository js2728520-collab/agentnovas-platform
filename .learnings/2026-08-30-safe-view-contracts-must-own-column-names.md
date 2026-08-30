# Learning: Safe views own their consumer-facing column contract

**Date**: 2026-08-30
**Type**: error
**Agent**: ben

## Context

The AI control-plane repository was moved from raw tables to security-barrier Maintenance views.

## Problem/Issue

The probe view intentionally renamed `requested_at` to `tested_at`, but the repository query continued selecting `requested_at AS tested_at`. TypeScript could not detect the SQL mismatch; the PostgreSQL integration test failed with `42703 column requested_at does not exist`.

## Solution

The repository now queries the safe view's published `tested_at` column directly. The PostgreSQL integration test remains the executable contract between every safe projection and its consumer.

## Key Insights

- A security view is a public data interface, not a transparent alias for its underlying table.
- Repository code must depend only on view column names when least-privilege roles cannot read the underlying tables.
- Static TypeScript checks do not replace executing SQL against a real PostgreSQL schema.

## Prevention

For each safe view, keep one integration test that creates the schema, queries through the production repository, and separately asserts the absence of forbidden columns.

## See Also

- `postgres/migrations/0093_ai_control_plane.sql`
- `lib/ai-control-plane-repository.ts`
- `tests/ai-control-plane-postgres.test.mjs`
