# T8.1c restricted CI/CD Worker evidence

Date: 2026-08-27
Status: implementation complete; runtime remains disabled pending later T8 slices and G7 activation

## Delivered boundary

- Independent `release-orchestrator` process and systemd/container definitions. The checked-in switch is
  `RELEASE_ORCHESTRATOR_WORKER_ENABLED=false`.
- Strict GitHub.com binding parser with a code-recomputed `providerBindingSha256`; the App private key is an absolute,
  regular, non-symlink secret file with permissions no broader than `0440`.
- Per-iteration App/installation verification, a repository-scoped installation token, control-tag/commit/workflow
  drift checks, a fixed dispatch envelope, exact response URL checks, and exact run verification.
- Persist-before-POST database facts. An ambiguous dispatch is never retried; an expired persisted dispatch is atomically
  converted to `worker_recovery`, blocks the environment, and prevents a later command from being leased first.
- Immutable provider binding material in PostgreSQL. Claim requires both the configured digest and the full material;
  run URLs are derived from that matched repository binding rather than a hard-coded repository name.
- `agentnovas_release_worker` is a narrow LOGIN role with `PASSWORD NULL` on first creation, no direct table or sequence
  grant, and only pinned security-definer gateways. The other restricted CI/CD roles remain NOLOGIN.

This slice does not add Ingress, Auditor, target deployment, GitHub workflow/environment configuration, credentials, or
production activation. Real perpetual order routing remains disabled and out of scope.

## Verification

Remote host `an-saas` was used for resource-heavy checks against an isolated PostgreSQL database and Node 22.21.1:

- 80 forward migrations applied successfully; rerun/checksum behavior exercised by database tests.
- Least-privilege role template applied; `postgres-role-policy.mjs` returned `findings: []`.
- Restricted CI/CD PostgreSQL suites passed, including concurrent lease behavior, persist-before-POST, exact run binding,
  and synthetic crash recovery after lease expiry.
- Provider, Worker, deployment contract, role-policy, production configuration, and isolation tests passed.
- TypeScript `tsc --noEmit --incremental false` and targeted ESLint passed.

No real GitHub credential was provisioned and no live GitHub dispatch was performed. Those are G7 operational evidence,
not evidence that can be fabricated by a unit or database test.

## Operational prerequisites for later activation

1. Create the dedicated private GitHub App and independently capture the private-visibility/admin evidence because
   GitHub REST `GET /app` does not return a `public` field.
2. Populate the exact repository/App/workflow IDs and recompute the binding digest with the shipped code.
3. Install the App private key and binding file at mode `0400`; provision the database password outside Git.
4. Complete T8.2 Ingress/Auditor/target-gateway slices, protected environment/ruleset evidence, and the G7 manifest.
5. Only then change the runtime switch under dual-control activation. The checked-in default remains false.
