# Remote shell SQL literals should use stdin

- Date: 2026-08-29
- Context: preview PostgreSQL migration verification over `ssh` and `docker exec`.
- Failure: a SQL `IN ('...')` predicate was embedded through multiple shell quoting layers. The remote shell removed the string quotes and PostgreSQL rejected the read-only verification query after the migration had already succeeded.
- Rule: for remote SQL containing string literals, pass the query via protected stdin/heredoc or a mounted SQL file. For short evidence checks, prefer a query that avoids literals entirely. Do not interpret a follow-up evidence-query failure as a migration failure; verify the migration registry separately.
- The same rule applies to `awk '$1'` and PostgreSQL `$$...$$`: the outer shell can expand them before the remote program sees them. Prefer `cut`, a checked script file, or single-quoted stdin over nested `ssh '...'` one-liners.
- A module's CLI-only function cannot be assumed to be exported. When a container gate intentionally invokes a file through its `import.meta.url === pathToFileURL(process.argv[1]).href` guard, preserve that entrypoint contract instead of importing an internal function by name.
