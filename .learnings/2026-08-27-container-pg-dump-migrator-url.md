# Learning: Container pg_dump must parse the migrator URL without argv leakage

**Date**: 2026-08-27
**Type**: error
**Agent**: Codex

## Context

T8.2d2b replaced a hand-authored preview backup command with a release gate that streams a custom PostgreSQL dump,
verifies its TOC, and records SHA-256.

## Problem/Issue

The first implementation executed `pg_dump` as the PostgreSQL container's `POSTGRES_USER`, which was the `postgres`
superuser and violated the FORCE RLS rule requiring the dedicated migrator plus `--enable-row-security`. After moving to
the migrator env, setting a connection URI in `PGDATABASE` did not work: libpq treated it as a database name and attempted
the default Unix socket. Trying to override the URI host with `--host` also did not produce the intended connection.

## Solution

Mount the migrator env read-only into a one-shot PostgreSQL tools container sharing the database container's network
namespace. A fixed Perl-core entrypoint reads exactly one `DATABASE_URL`, strictly parses and percent-decodes the user,
secret, and database components, rejects malformed encodings/control characters, and sets
`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`. It then execs `pg_dump --enable-row-security`; the URL never appears in
host or container process arguments.

## Key Insights

- Backup correctness includes database-role policy; a readable superuser dump can still be noncompliant evidence.
- `PGDATABASE` is not a safe substitute for a libpq connection URI in this execution shape.
- Do not source a secret env file or hand-parse URL authorities in shell when percent-encoding matters.
- A fixed parser already present in the pinned tools image avoids adding dependencies and keeps credentials out of argv.

## Prevention

Container backup tooling must be tested against the real migrator env and database network namespace. Require
`--enable-row-security`, an exclusive `0600` output, independent `pg_restore --list`, and regression checks that the
execution plan contains no credential-bearing URI.
