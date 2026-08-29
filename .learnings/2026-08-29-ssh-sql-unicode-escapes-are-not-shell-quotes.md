# SSH SQL Unicode escapes are not shell quotes

## Context

While checking a disposable PostgreSQL database through `ssh` and `docker exec`, a JSON-style `\u0027` escape was passed literally to `psql`. PostgreSQL rejected it because neither the remote shell nor SQL interprets that sequence as a quote.

## Rule

For fixed, non-secret SQL sent through `ssh`, keep the SQL as a literal string and use ordinary SQL single quotes inside a locally double-quoted remote command. Do not use JSON Unicode escapes as a substitute for shell or SQL quoting. Prefer a checked script or stdin for dynamic SQL instead of adding another quoting layer.
