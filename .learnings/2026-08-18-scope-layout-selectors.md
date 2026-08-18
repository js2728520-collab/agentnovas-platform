# Learning: Scope layout selectors to the structural child they own

**Date**: 2026-08-18
**Type**: error
**Agent**: Codex

## Context
An inline AI confirmation card used an `aside` element inside the dashboard conversation area.

## Problem/Issue
Legacy selectors such as `.dash aside` treated every nested `aside` as the dashboard navigation rail. The confirmation card inherited sticky positioning, viewport height, overflow, and column layout, producing a large empty black panel.

## Solution
Changed the related confirmation card to a labeled `div` group and made the modal dialog's viewport centering explicit instead of relying on user-agent defaults.

## Key Insights
- Structural layout selectors should target direct children such as `.dash > aside`, not every semantic element below a page shell.
- A semantic tag can accidentally become a styling API when broad descendant selectors exist.
- Critical modal placement should be explicit and verified at desktop and mobile viewport sizes.

## Prevention
Before adding semantic layout elements inside a legacy shell, search for broad tag selectors. Add a regression contract for element type and modal positioning when the stylesheet cannot be isolated immediately.

## See Also
- `.learnings/2026-08-18-dialog-autofocus-accessibility.md`
