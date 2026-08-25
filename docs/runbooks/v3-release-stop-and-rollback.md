# V3 release stop and rollback

Status: `TARGET`
Date: 2026-08-24

## Purpose

This runbook is a documentation-only stop and rollback reference for the V3 release slice. It does not authorize deployment or production changes.

## Stop conditions

Declare a hard stop when any of the following occurs:

- Secret, customer credential, full private endpoint, unauthorized PII, or cross-audience/scope data is exposed.
- An unknown order is classified as not placed or filled; Paper, Demo, and Live facts are mixed; a ledger is unbalanced, duplicated, or not reproducible.
- A migration/checksum differs, the artifact is not the same one tested in staging, or the rollback target was not previously successful in the same environment.
- Any external capability is shown as configured, healthy, sent, filled, paid, or enabled without corresponding evidence.
- A live reconciliation fork, unresolved order, kill-switch failure, or safety-critical 5xx/latency/alerting failure occurs.
- Required approver, on-call owner, evidence, or stop authority is missing.

The release owner may pause work for any listed condition; the incident commander or designated rollback owner may stop traffic and workers. The names and contact paths must be filled in the candidate release record before go-live.

## Immediate actions

1. Stop new release approvals and freeze new traffic/capability grants.
2. Stop new worker claims and external writes; preserve queues, events, append-only audit records, and request IDs.
3. Keep the current environment observable; do not delete evidence or rewrite history.
4. Preserve the existing worktree state for a documentation conflict.
5. Re-read the authoritative sources listed in `docs/quality/V3_EVIDENCE_INDEX.md`.
6. Reconcile only the specific conflicting claim.
7. Update the ledger with `unknown`, `unverified`, or `blocked` instead of guessing.

For a real-live incident, the execution/service kill switch must block new opens while preserving safe exits and reconciliation. This documentation slice does not provide or exercise that control.

## Rollback procedure

1. Confirm the incident timeline, request IDs, current version, intended previous version, and authority.
2. Freeze new release actions and external writes; retain queues/events and audit evidence.
3. Atomically switch `current` to the immutable, same-environment artifact previously recorded as `previous`.
4. Do not reverse or delete applied forward-compatible migrations. Correct business facts with compensating/reversal entries; restore from backup only with explicit approval and validated RPO/RTO.
5. Verify host/audience/login, readiness, critical API, queue/worker, ledger, and reconciliation smoke checks.
6. Record exact version `from`/`to`, artifact and migration checksums, smoke output, approvers, and final environment state in the incident evidence.

A rollback is invalid if staging did not succeed for that exact version, if the artifact is mutable/unhashed, or if the target was not a prior successful deployment in the same environment.

## Rollback boundary

For this slice, rollback means undoing only the documentation edits in the four V3 files:

- `docs/quality/V3_GATE_LEDGER.md`
- `docs/quality/V3_RELEASE_SCOPE.md`
- `docs/quality/V3_EVIDENCE_INDEX.md`
- `docs/runbooks/v3-release-stop-and-rollback.md`

No code, migration, task, handoff, or production rollback is in scope.

## Concurrent-change handling

If another agent or user changes the same files concurrently:

- Do not overwrite unrelated sections.
- Re-read the changed file before editing again.
- Merge by claim, not by wholesale replacement.
- Preserve explicit unknowns if the new evidence is still incomplete.

## Verification notes

- There is no claim here that a deployment has happened.
- There is no claim here that live trading or withdrawal gates have opened.
- There is no claim here that migration bodies were audited in this slice.

## Exit condition

The documentation slice is complete when the four V3 files exist, their claims are explicit about uncertainty, and `git diff --check` passes for them. Pre-existing, unrelated worktree changes are preserved and reported separately; their presence is not a reason to delete, overwrite, or absorb them into this slice.