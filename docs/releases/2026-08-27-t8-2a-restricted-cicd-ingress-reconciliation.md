# T8.2a restricted CI/CD Ingress and reconciliation evidence

Date: 2026-08-27
Status: implementation complete; public route and both runtime switches remain disabled pending T8.2b–T8.2d and G7

## Delivered boundary

- Independent `release-webhook-ingress` process with an exact internal path, a 256 KiB raw-body limit, strict
  `workflow_run` envelope validation, constant-time `X-Hub-Signature-256` HMAC verification, delivery UUID replay
  protection, and append-only normalized delivery facts. Raw bodies, signatures, headers, and secrets are not stored.
- A dedicated `agentnovas_release_ingress` LOGIN role with `PASSWORD NULL` on first creation, no direct table/sequence
  access, and only the pinned `release_workflow_append_delivery` security-definer gateway.
- Authoritative asynchronous reconciliation in the release Worker. Webhooks remain wake/evidence facts only; command
  projection advances only after an exact GitHub run query revalidates repository, workflow, ref, commit, attempt,
  status, conclusion, and provider timestamp.
- Terminal provider facts leave the reconciliation queue, and a reconciliation pass no longer suppresses the normal
  dispatch pass. This prevents a successful run waiting for a target receipt from starving another environment.
- Bare-metal systemd trust domains now use distinct `agentnovas-release-worker` and
  `agentnovas-release-ingress` UIDs, systemd credential namespaces, hidden `/etc/agentnovas`, and proc isolation.
  Client/Operations/Maintenance Web units also cannot traverse `/etc/agentnovas`. Container services retain separate
  secret mounts and networks.
- Both checked-in runtime switches remain `false`, and Nginx deliberately has no release webhook route in this slice.

The implementation follows GitHub's official [webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[webhook operational guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks),
and [workflow-run REST contract](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10).

## Verification

Resource-heavy verification ran on `an-saas` with Node 22.21.1 and isolated PostgreSQL 16.14 containers:

- 81 forward migrations applied to a fresh database; the least-privilege role template completed and
  `postgres-role-policy.mjs` returned `findings: []`.
- Restricted CI/CD PostgreSQL suites passed 14/14, including delivery replay, provider authority, terminal
  reconciliation exclusion, target receipt precedence, stop ordering, persist-before-POST, and expired-dispatch
  recovery.
- Final Ingress/Worker/systemd/deployment isolation suite passed 30/30; the wider T8.2a targeted suite passed 68/68.
- TypeScript `tsc --noEmit --incremental false`, targeted ESLint, shell syntax, and systemd unit syntax passed. The
  remote verification host lacks `/usr/bin/npm`, so `systemd-analyze verify` emitted only that expected host-path
  diagnostic.
- First fresh-context review found two High issues: shared systemd UID trust-domain collapse and terminal-success
  reconciliation starvation. Both were fixed; the second review reported no Critical/High.

No real GitHub credential was provisioned, no webhook endpoint was published, no workflow was dispatched, no preview
domain was replaced, and no production service/database was touched.

## Remaining gates

1. T8.2b must implement the OIDC exact-run target gateway, durable target mutex/journal, generation/current CAS,
   fixed deployment adapter, and signed receipts.
2. T8.2c must add the Maintenance maker/checker/activation/stop UI with breakpoint and accessibility evidence.
3. T8.2d must add the immutable workflow/environment/runner fixtures and run staging, production, rollback,
   compromise, and G7 drills.
4. A real public webhook route and either runtime switch may be enabled only as an explicitly approved G7 operation.
