# Learning: Fixed session expiries make tests time-dependent

**Date**: 2026-08-30
**Type**: error
**Agent**: Codex

## Context

The Client MFA PostgreSQL test created sessions expiring at `2026-08-30T00:00:00Z` while a database gateway correctly compared validity with `CURRENT_TIMESTAMP`.

## Problem/Issue

The test passed before that instant and began failing later on the same calendar date, even though production behavior had not regressed.

## Solution

Use an explicit far-future expiry for the session fixture while keeping the MFA event timestamps fixed and deterministic.

## Key Insights

- Database functions that use wall-clock time can invalidate otherwise fixed test fixtures.
- Test credentials should either derive validity from the run clock or use a clearly bounded far-future value.

## Prevention

Never use a near-term calendar date as the validity boundary for a reusable session fixture.

## See Also

- `tests/client-account-mfa-postgres.test.mjs`
