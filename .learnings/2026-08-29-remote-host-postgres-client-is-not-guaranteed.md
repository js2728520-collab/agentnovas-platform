# Remote host PostgreSQL client is not guaranteed

## Context

The preview database backup was produced through the running PostgreSQL container, but the remote host did not provide `pg_restore`, so a host-side archive listing failed after the dump had already been written.

## Rule

Do not assume `psql`, `pg_dump`, or `pg_restore` exists on a self-hosted Docker node. Run PostgreSQL client verification with the same pinned PostgreSQL image as the database, mounting only the exact backup directory read-only. Keep backup creation and validation as separate commands so a missing host utility cannot make the dump result ambiguous.
