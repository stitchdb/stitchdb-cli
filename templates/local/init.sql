-- Local development database (stitchdb start): the roles, schemas and helpers a StitchDB project has, so migrations
-- written locally apply the same way on StitchDB. Runs once, as the bootstrap superuser "postgres", when the CLI builds
-- its database template. Local passwords are fixed and public on purpose ('postgres'): never reuse them.
\set ON_ERROR_STOP 1

alter role postgres password 'postgres';

-- API roles: anon (no user), authenticated (a signed-in user), service_role (your server; bypasses RLS).
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'postgres';
grant anon, authenticated, service_role to authenticator;
-- Internal roles of the auth and storage services (they own their schemas, as on StitchDB).
create role supabase_auth_admin login createrole noinherit password 'postgres';
create role supabase_storage_admin login createrole noinherit password 'postgres';
grant anon, authenticated, service_role to supabase_storage_admin;

create schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role, supabase_auth_admin, supabase_storage_admin;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;
alter database postgres set search_path = "$user", public, extensions;

grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;

-- Auth: the auth service creates its tables here on its first start.
create schema auth authorization supabase_auth_admin;
grant usage on schema auth to postgres, anon, authenticated, service_role;
alter role supabase_auth_admin set search_path = auth;
alter default privileges for role supabase_auth_admin in schema auth grant all on tables to postgres;
alter default privileges for role supabase_auth_admin in schema auth grant all on sequences to postgres;
alter default privileges for role supabase_auth_admin in schema auth grant all on functions to postgres;

-- Storage: buckets and objects (the local storage service keeps the files on disk and the rows here, so your
-- policies on storage.objects decide who may read and write, as on StitchDB).
create schema storage authorization supabase_storage_admin;
grant usage on schema storage to postgres, anon, authenticated, service_role;
set role supabase_storage_admin;
create table storage.buckets (
  id text primary key, name text not null unique, owner uuid, owner_id text, public boolean not null default false,
  avif_autodetection boolean default false, file_size_limit bigint, allowed_mime_types text[], type text not null default 'STANDARD',
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default extensions.gen_random_uuid(), bucket_id text references storage.buckets (id), name text,
  owner uuid, owner_id text, created_at timestamptz default now(), updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(), metadata jsonb, path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text, user_metadata jsonb
);
create unique index bucketid_objname on storage.objects (bucket_id, name);
create index name_prefix_search on storage.objects (name text_pattern_ops);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to postgres, anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end $$;
create function storage.filename(name text) returns text language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $$;
create function storage.extension(name text) returns text language plpgsql immutable as $$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end $$;
reset role;

-- Realtime: realtime.messages (policies on it decide who may use private channels), realtime.topic(),
-- realtime.send() and the publication whose tables send their changes.
create schema realtime;
grant usage on schema realtime to postgres, anon, authenticated, service_role;
create table realtime.messages (
  id uuid primary key default extensions.gen_random_uuid(), topic text not null, extension text not null, payload jsonb,
  event text, private boolean default false, updated_at timestamp not null default now(), inserted_at timestamp not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert, update, delete on realtime.messages to postgres, anon, authenticated, service_role;
create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '')::text $$;
create publication stitchdb_realtime;

-- Local only: changes and messages go to the local realtime service through this queue (it LISTENs on
-- "stitchdb_realtime"), because the local runtime has no replication service.
create unlogged table realtime._local_events (id bigserial primary key, kind text not null, body jsonb not null, at timestamptz not null default now());
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into realtime.messages (topic, extension, payload, event, private) values (topic, 'broadcast', payload, event, private);
  insert into realtime._local_events (kind, body) values ('broadcast', jsonb_build_object('topic', topic, 'event', event, 'payload', payload, 'private', private));
  perform pg_notify('stitchdb_realtime', '');
end $$;
grant execute on function realtime.send(jsonb, text, text, boolean) to postgres, anon, authenticated, service_role;
create function realtime._local_change() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into realtime._local_events (kind, body) values ('change', jsonb_build_object(
    'relid', tg_relid, 'schema', tg_table_schema, 'table', tg_table_name, 'type', tg_op,
    'record', case when tg_op <> 'DELETE' then to_jsonb(new) end, 'old_record', case when tg_op <> 'INSERT' then to_jsonb(old) end,
    'commit_timestamp', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  perform pg_notify('stitchdb_realtime', '');
  return null;
end $$;
-- Keeps a row trigger on every table of the publication (tables added, removed, created later with FOR ALL TABLES).
create function realtime._local_sync() returns event_trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select t.tgrelid::regclass as rel from pg_trigger t where t.tgname = 'stitchdb_realtime_local'
      and not exists (select 1 from pg_publication_tables p where p.pubname = 'stitchdb_realtime' and format('%I.%I', p.schemaname, p.tablename)::regclass = t.tgrelid) loop
    execute format('drop trigger stitchdb_realtime_local on %s', r.rel);
  end loop;
  for r in select format('%I.%I', p.schemaname, p.tablename) as rel from pg_publication_tables p where p.pubname = 'stitchdb_realtime'
      and not exists (select 1 from pg_trigger t where t.tgname = 'stitchdb_realtime_local' and t.tgrelid = format('%I.%I', p.schemaname, p.tablename)::regclass) loop
    execute format('create trigger stitchdb_realtime_local after insert or update or delete on %s for each row execute function realtime._local_change()', r.rel);
  end loop;
end $$;
create event trigger stitchdb_realtime_local on ddl_command_end
  when tag in ('CREATE PUBLICATION', 'ALTER PUBLICATION', 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE')
  execute function realtime._local_sync();

-- Migration history (same table as on StitchDB).
create schema stitchdb_migrations;
create table stitchdb_migrations.schema_migrations (version text primary key, name text not null default '', checksum text not null,
  statements text not null, applied_at timestamptz not null default now(), applied_by text, duration_ms int);
