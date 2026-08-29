# Learning: Release audits need `pipefail` and explicit interpreters

**Date**: 2026-08-27
**Type**: error
**Agent**: Chris

## Context

A remote preview configuration audit was invoked directly from an rsynced source snapshot and piped
through `tee` for evidence capture.

## Problem/Issue

The snapshot did not preserve an executable bit for the audit script, so direct execution returned
`Permission denied`. Because the remote shell had `set -e` but not `set -o pipefail`, `tee` returned
zero and the command continued.

## Solution

Invoke repository shell audits with an explicit interpreter (`bash path/to/script.sh`) and enable
`set -o pipefail` before piping output to `tee`. Rerun the audit against the installed configuration
and treat only that later evidence as authoritative.

## Key Insights

- `set -e` alone does not propagate a failure from the left side of a pipeline.
- Deployment snapshots may not retain executable mode even when file content is correct.
- Evidence capture must not change the exit semantics of a release gate.

## Prevention

Every release command that uses `| tee` must start with `set -o pipefail`; scripts copied into a
release snapshot should be invoked through their declared interpreter unless executable mode was
explicitly verified.

## See Also

- `.learnings/2026-08-27-pg-dump-does-not-accept-psql-variables.md`
- `docs/releases/2026-08-27-t8-2d2b-preview-deployment.md`
