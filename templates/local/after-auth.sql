-- Local development database, after the auth service created its tables (see init.sql).
\set ON_ERROR_STOP 1

-- The claims of the request's JWT (set by the REST server, the local storage and realtime services).
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant execute on function auth.jwt() to postgres, anon, authenticated, service_role;
grant select on auth.users to postgres;
