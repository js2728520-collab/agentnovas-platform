# Learning: Read-only TypeScript validation must disable incremental output

**Date**: 2026-08-29
**Type**: error
**Agent**: Codex

## Context

The remote validation source was mounted read-only in a Node 22.21.1 container and checked with `tsc --noEmit`.

## Problem/Issue

The repository enables incremental compilation, so TypeScript still attempted to write `tsconfig.tsbuildinfo` even with `--noEmit`. The check exited with `TS5033` because `/workspace` was read-only; this did not indicate a source-code type error.

## Solution

Run the read-only validation with `tsc --noEmit --incremental false`, or provide a dedicated writable `--tsBuildInfoFile` outside the source mount when incremental behavior itself must be exercised.

## Key Insights

- `--noEmit` prevents JavaScript and declaration output but does not necessarily suppress incremental build metadata.
- Read-only source mounts are useful evidence boundaries, but build tools need every cache/output path disabled or redirected.

## Prevention

Remote read-only TypeScript Gate commands should include `--incremental false` by default.

## See Also

- `.learnings/2026-08-29-remote-validation-processes-need-unique-evidence.md`
