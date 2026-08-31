# Learning: zsh `status` is read-only

**Date**: 2026-08-29
**Type**: error
**Agent**: Chris

## Context
A read-only HTTP health-check loop assigned curl's status code to a shell variable named `status`.

## Problem/Issue
In zsh, `status` is a read-only special parameter, so assignment stopped the diagnostic command before any requests completed.

## Solution
Use a task-specific variable such as `http_code` for curl response codes.

## Key Insights
- Avoid shell special-parameter names even for short diagnostic scripts.
- Task-specific variable names make commands more portable and clearer.

## Prevention
Use `http_code`, `response_code`, or another task-scoped name for HTTP status values in zsh scripts.
