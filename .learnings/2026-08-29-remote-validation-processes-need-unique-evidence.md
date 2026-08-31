# Learning: Remote validation processes need unique evidence paths

**Date**: 2026-08-29
**Type**: error
**Agent**: Codex

## Context

A long remote `npm test` run was started through SSH and redirected to a fixed log filename. A later shell-preflight error and client-side interrupt made the SSH session state ambiguous, then another run reused the same log path.

## Problem/Issue

Two remote processes could write summaries into one evidence file, producing contradictory pass/fail counts. Shell field expansion inside a doubly quoted `awk` fragment also interacted with `set -u` before the intended port check.

## Solution

Inspect named processes and containers before retrying, use a unique container, port, database, and log filename per run, and let the remote command finish instead of treating an interrupted SSH client as proof that the remote child stopped. Prefer `ss` filters or Docker's own bind failure over shell-expanded field expressions.

## Prevention

- Give every long validation attempt a unique evidence path and resource suffix.
- Install an exact-name cleanup trap for disposable containers.
- After an interrupted SSH call, inspect remote processes before starting another run.
- Never aggregate evidence from a file that had multiple writers.
