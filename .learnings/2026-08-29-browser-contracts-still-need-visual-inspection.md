# Learning: Browser contracts still need visual inspection

**Date**: 2026-08-29
**Type**: error
**Agent**: Codex

## Context

The email-management acceptance script passed document-level horizontal-overflow and axe checks at 320px, but the captured screenshot still showed a short status pill split across two lines. Early script attempts also matched every tablist on the page instead of the email component's own tabs, and one run submitted login before hydration stabilized.

## Problem/Issue

Layout contracts can prove that the document does not overflow while missing poor wrapping inside a component. Generic ARIA selectors can also include nested or neighboring navigation systems, and DOM-ready alone is not always sufficient for a stable authenticated form submission.

## Solution

- Inspect representative screenshots after automated responsive checks.
- Keep pill labels on one line with bounded ellipsis behavior.
- Select reusable-component tabs by their component-specific `aria-controls` contract.
- Wait for the login page's network to become idle before submitting in deployed-site acceptance.
- Record edge-injected Cloudflare SRI warnings separately from application console failures.

## Prevention

For responsive browser Gates, combine geometry assertions, accessibility scans and visual inspection at the smallest and largest widths. Use stable component-owned semantics for selectors and preserve failed harness attempts as non-authoritative evidence.
