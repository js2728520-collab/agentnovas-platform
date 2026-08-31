# Preview MOCK data runbook

## Purpose

`scripts/seed-preview-mock-data.mjs` creates a deterministic, clearly marked dataset for the three test sites. It is intended for UI, RBAC, reporting, and workflow acceptance only.

The dataset includes:

- headquarters-linked branch offices, branch administrators, managers, supervisors, and employees;
- customer profiles and staff attribution;
- team targets and a resolved follow-up example;
- memberships, membership-order states, AI Credits, wallets, and balanced ledger entries;
- safe deposit examples in credited, failed, and manual-review states;
- three official Paper portfolios for the Client acceptance account, open positions, and historical Paper fills;
- one static AI conversation and terminal in-app notifications;
- one technical audit event identifying the dataset as `[MOCK]`.

## Safety boundary

- Run only against the three-site preview database after taking a protected backup.
- Every generated identity uses `@fixture.invalid`; its password is random and is never printed or retained.
- The script resolves the existing Client, Operations, and Maintenance acceptance roles as environment sentinels. Missing or duplicate sentinels stop the transaction.
- It creates no sessions or role assignments for generated identities.
- It creates no email delivery, provider-bound payment, provider address, external transaction identifier, live portfolio, or runnable strategy deployment.
- It does not change email, payment, AI, release, feature-flag, legal-disclosure, or health configuration.
- All writes occur in one transaction behind a PostgreSQL advisory lock. Re-running the command restores mutable MOCK facts and does not duplicate append-only facts.

## Required environment

Do not place the following values in a committed `.env` file:

```text
PREVIEW_MOCK_DATA_CONFIRMATION=seed-agentnovas-test-sites
PREVIEW_MOCK_DATABASE_HOST=<exact PostgreSQL host from the connection URL>
PREVIEW_MOCK_DATABASE_URL=postgresql://<role>:<password>@<exact host>:5432/agentnovas
```

The CLI rejects a different database name, host mismatch, missing acceptance sentinels, or an outdated migration chain.

## Apply and verify

After the preview backup is complete:

```bash
npm run preview:mock-data -- --apply
npm run preview:mock-data -- --verify
```

The command prints only aggregate counts and safety findings. It does not print database credentials, customer email addresses, password hashes, provider identifiers, or PII.

Expected verification totals for version 1 are 2 generated organizations, 16 generated identities, 7 customer profiles, 5 memberships, 9 Paper portfolios, 4 Paper fills, and 5 deposit examples. All unsafe counters must remain zero.

## Acceptance checks

- Client: sign in with the existing Client acceptance account and check the data dashboard, Trading Center portfolio/record tabs, Account Center, AI Assistant, and notifications.
- Operations: check the operations dashboard, organization directory, customers, team targets, data center, membership orders, deposits, Credits, and ledger.
- Maintenance: check Technical Audit for `maintenance.mock_dataset.seeded`; email, payment, model, integration, release, and health views must retain their real states.

## Reset behavior

This runbook intentionally provides no broad delete command. MOCK data shares relational and append-only tables with acceptance evidence. Restore the protected pre-seed database backup when a clean environment is required.
