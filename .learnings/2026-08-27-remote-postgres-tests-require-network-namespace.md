# Learning: Remote PostgreSQL tests need the database network namespace

**Date**: 2026-08-27
**Type**: error
**Agent**: Codex

## Context

The T8.2d2 container role-policy slice reused the persistent `an-saas` verification workspace and PostgreSQL fixture for
a full Node 22 quality run.

## Problem/Issue

The first full-suite tool container mounted the workspace but omitted `--network container:<postgres-container>`. All
PostgreSQL-backed tests consequently tried `127.0.0.1:5432` inside the isolated Node container and failed with
`ECONNREFUSED`; non-PostgreSQL tests, including the new gate tests, continued to run. A second attempt shared the network
but omitted the fixture-specific `TEST_DATABASE_URL`, so the tests reached PostgreSQL without a user/database and failed
uniformly with SQLSTATE `28000`.

## Solution

Run the Node tool container in the persistent PostgreSQL fixture's network namespace, after checking that the exact
database container is running and accepting an explicit, non-secret test connection URL. Pass that validated URL as
`TEST_DATABASE_URL`. Keep the source mount and Node image unchanged, then rerun the entire quality command so the result
is not inferred from either partial failure. The repository-wide PostgreSQL suite must also use
`--test-concurrency=1`: a parallel run reached 1,577/1,583 before PostgreSQL exhausted shared lock memory and reported
SQLSTATE `53200`, which is a fixture-capacity failure rather than a valid quality result. Restarting and reusing that
fixture was still invalid: earlier least-privilege tests had intentionally retained named roles with database CONNECT
revoked, causing two later role-fixture cases to fail with `42501`. A fresh Alpine tmpfs experiment also terminated the
database early and was not a reliable substitute for the established Bookworm image plus data volume.

## Key Insights

- A host-side PostgreSQL container does not make loopback available inside a sibling tool container.
- The repository's PostgreSQL tests intentionally use loopback; sharing the database container network namespace is the
  explicit remote-test transport.
- Uniform `ECONNREFUSED 127.0.0.1:5432` across database hooks indicates orchestration before it indicates a code defect.

## Prevention

Before every remote full-suite command, verify the selected PostgreSQL fixture state and database/user identity, then
include both `--network container:<validated-fixture-name>` and the matching `TEST_DATABASE_URL` in the Node
tool-container invocation. For the full repository suite, use a fresh `postgres:16.14-bookworm` fixture with a disposable
Docker data volume and invoke Node test directly with `--test-concurrency=1`; never reuse a role-policy fixture. Clean up
only the exact temporary container and its anonymous volume after the run.
