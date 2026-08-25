# V3 Release Scope

Status: `TARGET`
Date: 2026-08-24
Owner: `unassigned`
Approver: `unassigned`
Rollback owner: `unassigned`
Scope freeze: `not frozen`
Go / no-go: `NO-GO — documentation slice only`
Purpose: record the narrow release slice that this documentation pass covers.

## Candidate release slices

| Slice | Intended capability | Current decision |
| --- | --- | --- |
| S0 | In-app Client/Operations/Maintenance with only independently gated Paper/Demo, AI, strategy-marketplace, membership/Credits, and controlled notification capabilities | `NO-GO`; each dependency gate and external capability state still requires fresh evidence |
| S1 | One explicitly named `(provider, production, spot)` canary | `BLOCKED`; G4/G4A, explicit authorization, and all three named live blockers remain prerequisites |
| S2 | Additional spot providers | `BLOCKED`; approved independently per provider/environment/product after S1 |
| S3 | Perpetual, withdrawal/transfer, or CI/CD control plane | `BLOCKED`; each requires a separate ADR, threat model, gate, approval, and release |

This document does not enable any slice. S0 is the recommended first candidate shape, not an assertion that Paper, Demo, Email, payment, or other external effects are production-approved.

## Capability matrix

The release record must distinguish `process running`, `feature enabled`, `external write enabled`, and `production approved`; none implies another.

| Provider / product / capability | Environment | Process | Feature | External writes | Production approval |
| --- | --- | --- | --- | --- | --- |
| In-app Paper | Candidate environment not fixed | `unknown` | `unknown` | Not applicable (server-side simulated ledger only) | `unverified` |
| Platform Demo exchanges | Candidate environment not fixed | `unknown` | `unknown` | `disabled unless separately authorized` | `unverified` |
| Email / Resend | Candidate environment not fixed | `unknown` | Safe degradation only | `disabled/unverified` | `unverified` |
| Payment / Udun | Candidate environment not fixed | `unknown` | `disabled/unverified` | `disabled` | `not approved` |
| Real spot | All environments unless a specific grant says otherwise | Infrastructure may exist | Named readiness gate closed | `disabled` | `blocked` |
| USDT perpetual | All | Irrelevant | `disabled` | `disabled` | `blocked` |
| Withdrawal / transfer | All | Not an Execution Service capability | Endpoint absent or fixed rejection | `disabled` | `blocked` |
| Maintenance CI/CD trigger | All | Release registry is not a deploy executor | `disabled` | `disabled` | `blocked` |

Exact providers, products, markets, audiences, environments, owners, monitoring window, incident thresholds, and rollback conditions must be frozen in the candidate-specific copy before any go decision.

## In scope

- V3 documentation framing for the current release gate set.
- Explicit status labeling for the gate ledger.
- A pointer set for evidence and rollback reading order.
- Clear separation of current facts, target design, blocked items, and unknowns.

## Out of scope

- Code changes.
- Database migrations.
- Handoff edits.
- Task list edits.
- Production configuration.
- Commit or push operations.
- Any claim that live trading, withdrawal, or perpetual routing has been enabled.

## Current release facts

- Real spot has a named, per-provider unlock path but is currently blocked by the live-readiness list and requires explicit authorization.
- USDT perpetual must remain disabled under the repository rules; it cannot inherit a real-spot approval.
- Withdrawal/transfer endpoints must remain absent or fixed-rejection until the independent G5 funds-movement gate passes; the Execution Service must never gain withdrawal permission.
- Maintenance-triggered CI/CD remains blocked under G7.
- The latest visible migration file in this worktree is `postgres/migrations/0089_strategy_work_record_truncate_retention.sql`. Existing documented backup/restore evidence covers only through `0062`, so it is invalid for this candidate until the complete current chain and checksums are rerun.
- `docs/quality/FULL_PLATFORM_V3_GATES.md` remains the principal gate reference.
- `docs/DEVELOPMENT_HANDOFF.md` remains historical evidence, not a fresh validation run for this slice.

## Unknowns

- Fresh current proof for every V3 gate is not available from this slice.
- Migration bodies beyond the file names were not audited here.
- Whether the current release tranche should advance beyond documentation only is unknown and blocked on separate validation work.

## Release boundary

This slice is documentation-only. It narrows the release conversation to the gate ledger, evidence index, and rollback/runbook pointers without changing implementation state.
