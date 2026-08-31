# Learning: Parameterized node-postgres fixtures must use one statement

**Date**: 2026-08-29
**Type**: error
**Agent**: Codex

## Context

The isolated PostgreSQL test for the reusable email-service management module initialized organizations, users, Provider state and Worker metadata in one SQL string while also passing JSON parameters.

## Problem/Issue

`node-postgres` switched to the extended query protocol because parameters were present. PostgreSQL rejected the string with `cannot insert multiple commands into a prepared statement` (`42601`), so the suite failed in its setup hook before testing application behavior.

## Solution

Keep parameter-free fixture statements together only when useful, then execute each parameterized `UPDATE` or `INSERT` as its own `pool.query` call. Rerun the unchanged behavioral assertions against a fresh disposable PostgreSQL container.

## Key Insights

- A SQL string that works through the simple query protocol can fail as soon as a parameters array is supplied.
- Setup-hook failures can make every test look broken; inspect the first hook error before changing domain code.
- JSON/secret-like fixture values should remain parameters even in tests; split statements instead of interpolating them.
- Reusing one parameter as both text and timestamp can also fail type inference; cast each occurrence explicitly when the fixture intentionally shares a value.
- A migration test for the current schema should normally replay the full ordered migration chain. A handpicked subset can miss tables, constraints, triggers, or operation-enum expansions and produce false domain failures.
- Legacy `sessions.expires_at` is text in this schema. Any new direct SQL comparison with `now()` must use `expires_at::timestamptz`; do not infer the column type from newer timestamp fields.

## Prevention

Use one SQL command per parameterized `pg` call in new fixtures. Reserve multi-command setup strings for parameter-free DDL or static seed data.
Prefer `runPostgresMigrations` for fresh-schema module tests, then assert the target migration appears in the applied set and that an immediate rerun skips it.

## See Also

- `tests/email-service-management-postgres.test.mjs`
