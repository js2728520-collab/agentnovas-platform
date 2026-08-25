# V3 Release Scope

Status: `CURRENT_SCOPE`
Date: 2026-08-25
Owner: `unassigned`
Approver: `unassigned`
Rollback owner: `unassigned`
Scope freeze: `frozen — scope decision only; release approval remains separate`
Go / no-go: `NO-GO — scope is agreed, release evidence and approval are still incomplete`
Purpose: record the current release boundary and distinguish it from later V3 target slices.

> **Current release decision (2026-08-25): S0 is the sole release scope for the current documentation and development tranche.** S0 means a controlled Paper/Demo commercial platform across Client, Operations, and Maintenance, with only independently gated capabilities that have current evidence. Spot Live, USDT perpetual, Withdrawal/Transfer, and Maintenance CI/CD triggers remain disabled and are later independent slices. This scope decision does not authorize deployment, production migration, external provider activation, or a go decision.

## Candidate release slices

| Slice | Intended capability | Current decision |
| --- | --- | --- |
| S0 | In-app Client/Operations/Maintenance with only independently gated Paper/Demo, AI, G3-evidenced Paper/Demo strategy-marketplace and Paper follow configuration, existing independently evidenced membership/Credits facts, and in-app-only notification degradation; real-order following, real author/platform settlement, performance-share settlement, live funds side effects, fixed Credits consumer, model/function price tiers, `provider_usage` switching, and editable Skill runtime execution are excluded | `CURRENT SCOPE — NOT YET GO`; each dependency gate and external capability state still requires fresh evidence; external Email/notification writes remain disabled or unverified |
| S1 | One explicitly named `(provider, production, spot)` canary | `LATER INDEPENDENT SLICE — BLOCKED`; G4/G4A, explicit authorization, and all three named live blockers remain prerequisites |
| S2 | Additional spot providers | `LATER INDEPENDENT SLICE — BLOCKED`; approved independently per provider/environment/product after S1 |
| S3 | Perpetual, withdrawal/transfer, or CI/CD control plane | `LATER INDEPENDENT SLICES — BLOCKED`; each requires a separate ADR, threat model, gate, approval, and release |

This document records the agreed current scope but does not enable any slice. S0 is the sole current release scope; it is not an assertion that Paper, Demo, Email, payment, or other external effects are production-approved. Strategy-marketplace and follow wording covers only Paper/Demo behavior with independent G3 evidence. S0 may retain immutable fee-contract snapshots and display Paper-only simulated performance-share and author/platform allocations, but every result must say simulated, non-withdrawable, and unsettled; no customer service-balance debit, real receivable/invoice/author balance, payment/refund effect, or funds-ledger posting is permitted. Real-order following waits for G4/G4A, while real author/platform settlement, performance-share settlement, and all live funds side effects wait for independent commercial/ledger Gates. Its membership/Credits wording covers only existing independently evidenced membership, reservation/settle/release, usage facts, and immutable Credits ledger facts; it expressly excludes any simulated fee allocation from Credits, customer service balances, real receivables, invoices, author balances, payment/refund effects, or funds-ledger postings. It also excludes the fixed Credits consumer, model/function price tiers, and `provider_usage` mode switching. Those form the separate T3.9b slice and require their own strict schema, deterministic tester, immutable historical pin, least-privilege consumer, rollback, and Gate. S1, S2, and S3 are later independent slices, not implicit contents of S0.

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
- The committed migration tail is `postgres/migrations/0088_follow_paper_book.sql`; `0089_strategy_work_record_truncate_retention.sql` is a preserved uncommitted worktree change and is not part of the committed W0 candidate.
- The current evidence records 17 high/moderate development-toolchain vulnerabilities, including 9 high, with a 2026-08-28 exception deadline before paid Beta invitations; this remains a release blocker pending remediation and re-scan.
- `docs/quality/FULL_PLATFORM_V3_GATES.md` remains the principal gate reference.
- `docs/DEVELOPMENT_HANDOFF.md` remains historical evidence, not a fresh validation run for this slice.

## Unknowns

- Fresh current proof for every V3 gate is not available from this slice.
- Migration bodies beyond the file names were not audited here.
- Whether S0 should advance to a go decision remains unknown and blocked on candidate-specific validation and approval; advancing beyond S0 is outside the current release scope.

## Release boundary

This documentation decision freezes S0 as the sole current release scope. It narrows the release conversation to S0 gates, evidence, and rollback/runbook pointers without changing implementation state or authorizing a go decision. Editable Skill runtime execution remains outside S0 and requires the independent T3.10 contract, consumer, and Gate; Prompt version governance and any Prompt consumer remain subject to their own evidence and Gate.
