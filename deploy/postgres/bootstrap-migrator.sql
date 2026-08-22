\set ON_ERROR_STOP on

-- Fresh-database pre-bootstrap only. The DBA sets/rotates the password through
-- an interactive secret channel after this script; no password is accepted as
-- a psql variable or embedded in repository SQL.
\if :{?agentnovas_database}
\else
  \echo 'agentnovas_database is required'
  \quit
\endif

SELECT current_database() = :'agentnovas_database' AS agentnovas_database_matches \gset
\if :agentnovas_database_matches
\else
  \echo 'Refusing to bootstrap a different database'
  \quit
\endif

SELECT current_database() ~ '^agentnovas(_[a-z0-9]+)*$' AS agentnovas_database_is_controlled \gset
\if :agentnovas_database_is_controlled
\else
  \echo 'Refusing to bootstrap outside a controlled AgentNovas database'
  \quit
\endif

BEGIN;

DO $migrator$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_migrator') THEN
    CREATE ROLE agentnovas_migrator LOGIN PASSWORD NULL
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ELSE
    ALTER ROLE agentnovas_migrator LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$migrator$;

ALTER ROLE agentnovas_migrator SET search_path=pg_catalog,public;

REVOKE ALL PRIVILEGES ON DATABASE :"agentnovas_database" FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"agentnovas_database" TO agentnovas_migrator;
GRANT CREATE,USAGE ON SCHEMA public TO agentnovas_migrator;

COMMIT;
