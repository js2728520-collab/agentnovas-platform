# Learning: Multi-source rsync needs relative paths

**Date**: 2026-08-29
**Type**: error
**Agent**: Codex

## Context

Several selected files were incrementally synchronized into a remote validation source before a release candidate was built.

## Problem/Issue

Using multiple source paths without `--relative` flattened their directory structure into the destination root. This temporarily placed selected files beside the repository README instead of updating their canonical paths.

## Solution

Stop before building or deploying, remove only the exact unintended root files, and repeat the transfer with `rsync -aR` from the repository root. Verify the canonical destinations and root file list before creating a release source.

## Prevention

- Use `rsync -aR path/one path/two host:/exact/repository/root/` for selected repository files.
- Before every multi-source call, mechanically check for either `-R` or `--relative`; do not rely on remembering the prior incident.
- Prefer one whole-tree sync with exclusions when latency is acceptable. If selected-file sync is necessary, follow it immediately with `test -f` checks at every canonical destination and a root-level stray-file check.
- Never use `--delete` for incremental synchronization into a shared validation tree.
- Inspect the remote root and every intended destination before a build.
- Create immutable release directories only after synchronization integrity is confirmed.
