# Learning: Read-only remote Git scans need a container-local safe.directory

**Date**: 2026-08-27
**Type**: error
**Agent**: Codex

## Context

The T8.2d2 release-gate slice ran the repository secret scanner from a pinned Node 22 container against the remote
verification workspace mounted read-only at `/workspace`.

## Problem/Issue

Git rejected `git ls-files` with `fatal: detected dubious ownership in repository at '/workspace'` because the host
workspace owner differs from the container user. The scanner therefore stopped before examining any candidate files.

## Solution

Set `safe.directory=/workspace` only in the ephemeral tool container's command-scoped Git configuration, then run the
scanner. Do not change the repository, host user's global Git configuration, or mount permissions.

## Key Insights

- A read-only mount does not bypass Git's ownership protection.
- A scanner process exiting before candidate enumeration is not a successful zero-finding scan.
- The exception should name one validated mount path and live only for the tool-container process.

## Prevention

Remote Git-aware checks in a differently owned tool container must configure the exact read-only workspace as a
container-local `safe.directory` before invoking npm scripts that shell out to Git.
