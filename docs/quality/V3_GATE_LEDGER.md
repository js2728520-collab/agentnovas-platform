# V3 Gate Ledger

Status: `TARGET`
Date: 2026-08-24
Scope: narrow documentation slice for the approved W0 gate ledger update.

## Basis

This ledger is based on repository facts inspected in this worktree and the following current sources:

- `docs/README.md`
- `docs/quality/FULL_PLATFORM_V3_GATES.md`
- `docs/adr/0012-postgres-migrations-ledger-and-worker-evidence.md`
- `docs/adr/0019-ga-execution-service-and-key-custody.md`
- `docs/adr/0020-live-accounting-and-the-named-gate.md`
- `docs/adr/0021-full-platform-v3-gated-upgrade.md`
- `docs/DEVELOPMENT_HANDOFF.md`
- committed migration inventory ending at `postgres/migrations/0088_follow_paper_book.sql`; the preserved worktree-only migration `0089_strategy_work_record_truncate_retention.sql` is not part of commit `74582a1`
- `docs/quality/QUALITY_RELEASE_EVIDENCE.md`, including its recorded development-toolchain vulnerability exception

Unknown or unverified items are marked explicitly below.

## Release identity (must be completed per candidate)

The following fields are release facts, not prose claims. A blank or `unknown` value blocks approval:

| Field | Value | Evidence / owner |
| --- | --- | --- |
| Release slice / version tag | `unknown` | Set only after the candidate commit is fixed |
| Full commit SHA | `unknown` | `git rev-parse HEAD` for the candidate |
| Artifact SHA-256 | `unknown` | Immutable build artifact manifest |
| Release-evidence SHA-256 | `unknown` | `outputs/` manifest from the same commit |
| Migration version and checksum set | `unknown` | Migration registry export; must cover the complete chain |
| Target environment / platform | `unknown` | Environment record and platform owner |
| Previous version | `unknown` | Same-environment deployment record |
| Rollback target | `unknown` | Previously successful immutable artifact in the same environment |
| Same-version staging success | `unknown` | Staging deployment evidence before production approval |
| Release owner / approver / rollback owner | `unassigned` | Named people and independent approval required |

A documentation-only W0 slice deliberately leaves these values unresolved. It must not be copied into a production release record as if they were facts.

## Gate row contract

Every gate row must eventually carry: `gateName`, `gateStatus`, `environment`, `commitSha`, `migrationVersion`, `migrationChecksums`, `artifactSha256`, `evidencePointer`, `reviewer`, `approver`, `timestamp`, `requestId/idempotencyKey` where applicable, `blockerReason`, `currentVersion`, `previousVersion`, `rollbackTarget`, and invalidation conditions. `not_anchored`, `unverified`, `unknown`, and `blocked` are distinct non-pass states.

## Gate inventory

| Gate | Status | Evidence | Notes |
| --- | --- | --- | --- |
| G0 docs and product-parameter freeze | `PARTIAL` | `packages/contracts/src/product-parameters.ts`, `CLAUDE.md`, `docs/product/PRD.md`, `docs/quality/FULL_PLATFORM_V3_GATES.md` | The requirement owner froze P-01–P-12 on 2026-08-24 and the contracts module is the declared code source. G0 still does not pass: the main Gate checklist remains unchecked and the remaining provider, commercial-contract, withdrawal/transfer, ownership, environment, and exit-date items require evidence. |
| G1 identity, permissions, and registration links | `PARTIAL` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `docs/DEVELOPMENT_HANDOFF.md` | Some client MFA and registration evidence exists in the repo history, but current end-to-end production evidence was not rechecked here. |
| G2 market data and multi-market gate | `PARTIAL` | `docs/quality/FULL_PLATFORM_V3_GATES.md` | Current provider coverage and stale-data behavior were not re-verified in this slice. |
| G3 AI, strategy marketplace, and pricing gate | `PARTIAL` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `docs/adr/0021-full-platform-v3-gated-upgrade.md` | Strategy and commercial gating exist in target docs; current implementation evidence was not re-audited here. |
| G4 real-trading shared gate | `PARTIAL` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `docs/adr/0019-ga-execution-service-and-key-custody.md`, `docs/adr/0020-live-accounting-and-the-named-gate.md` | Execution service and live-accounting design are documented; live readiness remains constrained by named blockers. |
| G4A real spot gate | `BLOCKED` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `tasks/todo.md` | The repo rules still keep real spot routing closed until explicit authorization and the remaining live blockers are cleared. Phase 5 implementation is also incomplete, including continuous reconciliation, fork handling, activation entry, kill-switch/recovery drills, and canary evidence. |
| G4B USDT perpetual gate | `BLOCKED` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `CLAUDE.md` | Real perpetual routing must remain disabled. |
| G5 withdrawal, transfer, and service-fee gate | `BLOCKED` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `CLAUDE.md` | Client withdrawal permissions remain prohibited; service-fee or transfer exits are not opened by this slice. |
| G6 Operations and Maintenance gate | `PARTIAL` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `docs/README.md`, `docs/quality/QUALITY_RELEASE_EVIDENCE.md` | Target docs exist; this slice did not re-audit UI and RBAC evidence. The recorded development-toolchain exception (17 high/moderate vulnerabilities, including 9 high) remains a named release blocker pending remediation/re-scan before paid Beta invitations. |
| G7 CI/CD control-plane gate | `BLOCKED` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `docs/adr/0021-full-platform-v3-gated-upgrade.md` | The control-plane checklist is unpassed and Maintenance-triggered deployment remains unavailable. A target design is not implementation proof or authorization. |
| G8 experience and public-release gate | `PARTIAL` | `docs/quality/FULL_PLATFORM_V3_GATES.md`, `docs/README.md` | Release/runbook evidence exists, but current browser and accessibility proof were not rechecked here. |

## Named blockers

Current named live blockers in repo docs remain:

1. `EXCHANGE_BALANCE_NOT_RECONCILED`
2. `LIVE_ACTIVATION_ENTRY_MISSING`
3. `NEVER_EXECUTED_AGAINST_REAL_EXCHANGE`

Status of those blockers is unchanged by this documentation slice.

## Evidence notes

- `docs/DEVELOPMENT_HANDOFF.md` records multiple prior validation slices, but it is historical evidence, not a fresh re-run for this task.
- The product parameter contract P-01–P-12 is frozen as a requirements baseline; this does not mean the referenced providers, adapters, credentials, authorization, or runtime validation are configured or ready.
- The committed migration tail is `0088_follow_paper_book.sql`. `0089_strategy_work_record_truncate_retention.sql` is an uncommitted preserved worktree change whose body and cascade boundary are still under review; it is not evidence for commit `74582a1`.
- No code, migration, or production-config changes were made in this slice.

## Open questions

- Which V3 gates have fresh current evidence after the latest code changes is unknown from this slice.
- Whether the migration tail at `0089` is sufficient for the release tranche is unverified.
- Whether any gate has regressed since the last documented validation is unverified and should be checked by the next code slice.
