# Learning: Remote Node tests require a container and zsh reserves `status`

**Date**: 2026-08-27
**Type**: error
**Agent**: Codex

## Context

T8.1a used `an-saas` for a small RED unit-test run because local resources should be preserved.

## Problem/Issue

The first orchestration attempted to call `node` directly on the remote host, where Node is intentionally provided through
containers, and assigned the command result to zsh's read-only `status` parameter.

## Solution

Run the temporary source in the pinned `node:22.21.1-bookworm-slim` container and use a task-specific writable variable
such as `test_exit_code` when preserving the remote command result for cleanup.

## Key Insights

- `an-saas` host availability does not imply a host-level Node installation.
- Keep the project Node 22.21.0+ contract by using the same pinned test container as prior release evidence.
- zsh reserves `status`; use task-specific names for shell result variables.

## Prevention

For future remote JavaScript checks, create a validated temporary directory, run it through the pinned Node container,
capture the result in a task-specific variable, and remove only that explicit temporary directory.

## Recurrence

During the T8.2d2 release-gate slice, a host-level `node --version` probe repeated the already documented assumption.
Read matching `.learnings/` entries before choosing the remote execution shape; JavaScript release tooling on `an-saas`
must start in the pinned Node tool container, with the Docker socket mounted only when that tool must orchestrate Docker.

During M1.3, the same host-level assumption recurred twice (plain SSH and then `bash -lc`) before the learning was
re-read. Login-shell initialization does not change this host contract. The first remote JavaScript command must be a
`docker run --rm ... node:22.21.1-bookworm-slim` invocation; host probes should check Docker/image/workspace readiness,
not search for a host Node binary.
