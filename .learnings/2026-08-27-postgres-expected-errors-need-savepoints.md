# PostgreSQL expected-error assertions inside a transaction need savepoints

## Context

A PostgreSQL integration test opened one transaction, asserted that a security gateway rejected an invalid trust digest, and then exercised the valid path in the same transaction.

## Failure

The negative assertion correctly raised an error, but PostgreSQL marked the transaction aborted. Every later query failed with SQLSTATE `25P02`, obscuring the valid-path result.

## Rule

When an integration test intentionally triggers a PostgreSQL error inside a transaction that must continue, create a savepoint immediately before the expected failure and `ROLLBACK TO SAVEPOINT` immediately after the assertion. Alternatively, run the negative case in a separate transaction or connection.

## Verification

The restricted CI/CD workflow reservation test now isolates its invalid Auditor trust assertion with a savepoint before exercising the successful and replay paths.
