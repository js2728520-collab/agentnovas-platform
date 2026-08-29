# Learning: PostgreSQL fixtures must reuse domain bounds

**Date**: 2026-08-27
**Type**: error
**Agent**: Codex

## Context
The first remote T8.2c PostgreSQL run applied migration 0084, then failed while inserting its release fixture.

## Problem/Issue
The fixture used `release_notes='fixture'`, which violated the existing `release_versions_release_notes_check` before the new gateway behavior was exercised.

## Solution
Use a realistic release note that satisfies the established release-version domain constraint, then rerun against a fresh isolated schema.

## Key Insights
- New integration fixtures must honor all upstream table constraints, not only the migration under test.
- A hook failure during fixture creation does not constitute evidence about the new gateway and must be reported separately.
- `pg` returns PostgreSQL `bigint` columns as strings by default, while the same value inside `jsonb` is a number; normalize both sides before asserting a cross-representation equality.
- Quality identities use an explicit custom-role permission allowlist; adding a permission definition or bootstrap-admin grant does not update that browser fixture automatically.
- Projection tests that share a schema must assert the intended fixture IDs, not a global row count that becomes stale when another independent scenario is added.
- `pg` uses the extended protocol for parameterized queries; split parameterized fixture inserts into one SQL statement per call instead of combining multiple commands.

## Prevention
Copy valid fixture shapes from the nearest established PostgreSQL integration suite, update explicit browser-role allowlists with each new UI permission, or expose shared fixture builders when another release-control test is added.

## See Also
- `tests/restricted-cicd-postgres.test.mjs`
- `tests/restricted-cicd-maintenance-control-postgres.test.mjs`
