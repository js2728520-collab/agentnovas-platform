# Learning: `pg_dump` does not accept `psql` variables

**Date**: 2026-08-27
**Type**: error
**Agent**: Chris

## Context

While taking a custom-format preview backup before applying migration 0087, the command reused
`psql -v ON_ERROR_STOP=1` syntax with `pg_dump`.

## Problem/Issue

`pg_dump` interpreted `ON_ERROR_STOP=1` as an extra positional argument and exited before writing a
valid dump:

`pg_dump: error: too many command-line arguments (first is "ON_ERROR_STOP=1")`

## Solution

Run `pg_dump` without `psql` variable flags. Use its process exit status as the failure gate, then
validate the completed custom-format file with `pg_restore --list` before migration.

## Key Insights

- `ON_ERROR_STOP` is a `psql` client variable, not a shared PostgreSQL CLI option.
- A backup gate should check both the producer exit status and independent archive readability.

## Prevention

Keep `psql`, `pg_dump`, and `pg_restore` argument lists separate in deployment scripts and validate
the archive before any state-changing migration.

## See Also

- `.learnings/2026-08-27-postgres-expected-errors-need-savepoints.md`
