# Learning: Avoid forced focus inside an interactive dialog

**Date**: 2026-08-18
**Type**: error
**Agent**: Codex

## Context
An AI question-confirmation dialog conditionally renders a custom answer input.

## Problem/Issue
Targeted ESLint rejected the input's `autoFocus` prop because changing focus automatically can disorient keyboard and assistive-technology users.

## Solution
Removed forced focus. The native modal dialog still establishes a focus boundary, and users choose when to move into the custom input.

## Key Insights
- Opening a modal and focusing a newly revealed nested field are separate interactions.
- Native dialog focus behavior is sufficient unless a tested accessibility requirement says otherwise.

## Prevention
Do not add `autoFocus` to conditionally displayed form controls; verify keyboard navigation through the whole dialog instead.
