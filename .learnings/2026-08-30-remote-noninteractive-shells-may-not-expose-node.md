# Learning: Remote non-interactive shells may not expose Node

**Date**: 2026-08-30
**Type**: error
**Agent**: Codex

## Context

A quality run invoked `node` directly through `ssh an-saas` in an isolated validation directory.

## Problem/Issue

The non-interactive SSH shell did not have Node.js on `PATH`, even though the host supports Node-based validation through its container runtime.

## Solution

Run repository quality gates in the approved Node 22.21.1 container and mount only the isolated validation directory.

## Key Insights

- Interactive host configuration is not guaranteed in non-interactive SSH commands.
- Runtime version evidence should come from the exact container executing the checks.

## Prevention

Probe the execution environment first and prefer the established Node container on `an-saas` for reproducible validation.

## See Also

- `.learnings/2026-08-29-remote-validation-processes-need-unique-evidence.md`
