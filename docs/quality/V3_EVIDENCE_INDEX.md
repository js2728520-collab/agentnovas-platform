# V3 Evidence Index

Status: `TARGET`
Date: 2026-08-24

This file defines the evidence inventory contract. It does not certify a candidate. Historical evidence must never be relabeled as evidence for a newer commit or migration chain.

## Candidate evidence manifest

One row per retained artifact is required. `unknown`, missing hash, or mismatched commit/environment makes the associated gate non-pass.

| Artifact path / immutable URL | SHA-256 | Bytes | Generated at | Generator command / runner | Source commit | Migration version/checksums | Environment | Associated gate | Validity | Retention / cleanup |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| `not generated for W0` | `unknown` | — | — | — | `unknown` | `unknown` | `unknown` | — | `unverified` | — |

The candidate index must include, where applicable: unit/contract/PostgreSQL/security results; canonical E2E, MFA-on and rollout results; bundle and Lighthouse reports; release manifest; migration fresh/N-1/rerun/checksum/concurrent/backup-restore evidence; target-process `current_user` smokes; Nginx/systemd/Host/TLS evidence; deployment and rollback rehearsal records; browser console/network summaries and permitted traces; external provider evidence; audit-anchor export/verification; approvals and incident/on-call ownership.

Separate rows or sections are mandatory for current candidate evidence, historical deployment records, and invalidated/discarded evidence. Do not retain credentials, authorization/cookie material, MFA seeds/recovery codes, raw PII, private endpoints, or binary captures that cannot be safely scanned.

## Primary references

| File | Role | Current read status |
| --- | --- | --- |
| `docs/README.md` | Document entry point and reading order | Read |
| `docs/DEVELOPMENT_HANDOFF.md` | Historical implementation and validation record | Read |
| `docs/quality/FULL_PLATFORM_V3_GATES.md` | Main V3 gate checklist | Read |
| `docs/quality/ACCEPTANCE_AND_RELEASE_GATES.md` | Mandatory current Beta safety and release gates | Read |
| `docs/quality/QUALITY_RELEASE_EVIDENCE.md` | Current runner boundary, historical results, and evidence invalidation rules | Read |
| `docs/adr/0012-postgres-migrations-ledger-and-worker-evidence.md` | Migration and worker evidence baseline | Read |
| `docs/adr/0019-ga-execution-service-and-key-custody.md` | Execution service and credential custody baseline | Read |
| `docs/adr/0020-live-accounting-and-the-named-gate.md` | Named live gate and live accounting baseline | Read |
| `docs/adr/0021-full-platform-v3-gated-upgrade.md` | V3 staged upgrade decision | Read |

## Supporting repository facts

| File or path | Role | Current read status |
| --- | --- | --- |
| `postgres/migrations/0089_strategy_work_record_truncate_retention.sql` | Latest visible migration filename in this worktree | Not read |
| `docs/product/PRD.md` | Product-parameter source referenced by the gate docs | Not re-read in this slice |
| `docs/specs/SYSTEM_SPEC.md` | Current system contract referenced by the gate docs | Not re-read in this slice |

## Migration evidence boundary

`QUALITY_RELEASE_EVIDENCE.md` records restore evidence only through migration `0062`. The visible worktree migration tail is `0089`; therefore the historical restore result is invalid for this candidate until fresh, N-1, rerun, checksum, concurrent, and backup/restore evidence covers the complete current chain. Do not infer coverage from the filename alone.

## Evidence notes

- The index intentionally separates read sources from unverified references.
- A file appearing here does not mean its body was re-audited in this slice.
- The gate ledger should be treated as documentation state, not as proof that implementation state changed.

## Usage

Use this index as the entry point for the next validation pass:

1. Read the current gate ledger.
2. Recheck the listed source docs.
3. If a claim depends on code or migration content, inspect the underlying file before upgrading the status.
4. Mark unknowns explicitly instead of inferring completion.
