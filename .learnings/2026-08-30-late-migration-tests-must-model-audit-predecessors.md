# Learning: Late migration tests must model audit predecessors

**Date**: 2026-08-30
**Type**: error
**Agent**: Codex

## Context

The focused AI control-plane PostgreSQL test loaded the legacy LLM schema and migrations 0093/0094 without loading the earlier business/audit migrations.

## Problem/Issue

New `SECURITY DEFINER` configuration functions correctly write `audit_logs` in the same transaction, but the focused fixture had no `audit_logs` relation. DDL succeeded because PL/pgSQL resolves the relation when invoked; the first functional test then failed with `42P01`.

## Solution

Model the precise predecessor contract in the focused fixture by creating the audit columns used by 0093/0094. Keep the production migration dependent on the real ordered migration chain rather than weakening transactional auditing.

## Key Insights

- Re-runnable DDL tests do not prove late-bound PL/pgSQL dependencies exist.
- Every new database function should be invoked at least once in a PostgreSQL test.
- Focused late-migration fixtures must document and model required predecessor contracts.

## Prevention

When adding a late-chain function, add a functional invocation test and inventory every relation the function resolves at execution time.
