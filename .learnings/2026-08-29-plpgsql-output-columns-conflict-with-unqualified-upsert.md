# PL/pgSQL output columns can conflict with unqualified upsert columns

## Context

A `RETURNS TABLE` preference function exposed `user_id` and `app_audience` as PL/pgSQL output variables, then used `ON CONFLICT (user_id, app_audience)` inside the same function.

## Failure

PostgreSQL treated the conflict target as ambiguous because those names could refer either to table columns or function output variables. The migration replayed successfully, but the function failed only when the upsert path was executed.

## Durable rule

Inside PL/pgSQL functions with named parameters or `RETURNS TABLE` columns, do not rely on an unqualified column-list conflict target when names overlap. Prefer the exact named constraint, for example:

```sql
ON CONFLICT ON CONSTRAINT user_app_preferences_pkey
```

Exercise each SECURITY DEFINER function's read and mutation paths in a real PostgreSQL fixture; migration application alone does not validate runtime name resolution.
