# Learning: Ripgrep patterns starting with a dash need an option terminator

**Date**: 2026-08-30
**Type**: error
**Agent**: Codex

## Context

A pre-commit secret scan used a regular expression beginning with `-----BEGIN` to detect private-key headers.

## Problem/Issue

`rg` interpreted the leading dashes as command-line flags, so the intended content scan did not run.

## Solution

Pass `--` before a pattern that may begin with a dash: `rg -q -- '-----BEGIN ...' file`.

## Key Insights

- A successful surrounding shell loop does not prove that each nested scanner executed correctly.
- Security checks must fail visibly or be rerun after any scanner error.

## Prevention

Always include the option terminator before dynamically composed or dash-prefixed ripgrep patterns.

## See Also

- `security-and-hardening`
- `git-workflow-and-versioning`
