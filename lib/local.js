// Local development stack (stitchdb start/stop/status, db reset, local migrations, types and diffs).
// Docker Compose project "stitchdb_<project_id>" built from the same open-source services StitchDB runs:
// Postgres 17 (same extensions), Auth, REST, Realtime, Storage, Edge Functions runtime, Postgres meta (for the local
// Studio) and a mail catcher, behind one gateway on http://127.0.0.1:<api port>. Every port binds to 127.0.0.1 only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { fail, debug, sleep, writeFileSafe, c } = require('./util');
const { HOME } = require('./config');

const IMAGES = {
  db: 'supabase/postgres:17.6.1.136',
  auth: 'supabase/gotrue:v2.197.0',
  rest: 'postgrest/postgrest:v14.18',
  realtime: 'supabase/realtime:v2.143.3',
  storage: 'supabase/storage-api:v1.81.0',
  meta: 'supabase/postgres-meta:v0.100.0',
  functions: 'supabase/edge-runtime:v1.77.4',
  gateway: 'nginx:1.27-alpine',
  mail: 'axllent/mailpit:v1.20',
};
const OPTIONAL = ['auth', 'rest', 'realtime', 'storage', 'meta', 'functions', 'mail', 'studio'];
const LABEL = { db: 'Database', auth: 'Auth', rest: 'REST API', realtime: 'Realtime', storage: 'Storage', meta: 'Database API (Studio)', functions: 'Edge Functions', gateway: 'API gateway', mail: 'Mail catcher' };

// Local secrets: fixed and public on purpose (never use them anywhere else).
const JWT_SECRET = 'stitchdb-local-development-jwt-secret-not-for-production';
const DB_PASSWORD = 'postgres';
function sign(payload, secret = JWT_SECRET) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b({ alg: 'HS256', typ: 'JWT' })}.${b(payload)}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
}
const KEYS = {
  anon: sign({ iss: 'stitchdb-local', ref: 'local', role: 'anon', iat: 1760000000, exp: 2075000000 }),
  service: sign({ iss: 'stitchdb-local', ref: 'local', role: 'service_role', iat: 1760000000, exp: 2075000000 }),
};

// ---------- docker ----------
function dockerAvailable() {
  const r = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  return r.status === 0;
}
function requireDocker() {
  if (!dockerAvailable()) fail('Docker with the Compose plugin is required for local development.', { hint: 'Install Docker Desktop (or Docker Engine + Compose), start it, then try again.' });
}
function run(cmd, args, { input, inherit = false, allowFail = false, env } = {}) {
  debug('$', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  if (r.error) fail(`${cmd} failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(-800)}`);
  return r;
}

// ---------- configuration ----------
function settings(proj) {
  const cfg = proj.cfg || {};
  const ports = { api: cfg.api?.port || 54321, db: cfg.db?.port || 54322, studio: cfg.studio?.port || 54323, mail: cfg.inbucket?.port || cfg.mail?.port || 54324 };
  return {
    name: `stitchdb_${proj.id}`.replace(/-/g, '_'),
    dir: path.join(HOME, 'local', proj.id),
    ports,
    schemas: cfg.api?.schemas || ['public'],
    site: cfg.auth?.site_url || 'http://localhost:3000',
    redirects: cfg.auth?.additional_redirect_urls || [],
    jwtExpiry: cfg.auth?.jwt_expiry || 3600,
    signup: cfg.auth?.enable_signup !== false,
    confirm: cfg.auth?.email?.enable_confirmations === true,
    fileLimit: cfg.storage?.file_size_limit || '50MiB',
  };
}
const urls = (s) => ({
  api: `http://127.0.0.1:${s.ports.api}`, db: `postgresql://postgres:${DB_PASSWORD}@127.0.0.1:${s.ports.db}/postgres`,
  studio: `http://127.0.0.1:${s.ports.studio}`, mail: `http://127.0.0.1:${s.ports.mail}`,
  functions: `http://127.0.0.1:${s.ports.api}/functions/v1`,
});

function compose(proj, s, exclude) {
  const on = (svc) => !exclude.includes(svc);
  const bind = (host, inner) => `"127.0.0.1:${host}:${inner}"`;
  const dbEnv = `      POSTGRES_HOST: /var/run/postgresql
      PGPORT: 5432
      POSTGRES_PORT: 5432
      PGPASSWORD: ${DB_PASSWORD}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      PGDATABASE: postgres
      POSTGRES_DB: postgres
      JWT_EXP: ${s.jwtExpiry}`;
  const fnDir = proj.functionsDir.replace(/\\/g, '/');
  const svc = [];
  svc.push(`  db:
    image: ${IMAGES.db}
    restart: unless-stopped
    ports: [${bind(s.ports.db, 5432)}]
    volumes:
      - ./db/realtime.sql:/docker-entrypoint-initdb.d/migrations/99-realtime.sql:ro
      - ./db/roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro
      - ./db/jwt.sql:/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:ro
      - db-data:/var/lib/postgresql/data
      - db-config:/etc/postgresql-custom
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres", "-h", "localhost"]
      interval: 3s
      timeout: 5s
      retries: 40
    environment:
${dbEnv}
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "log_min_messages=fatal"]`);
  if (on('auth')) svc.push(`  auth:
    image: ${IMAGES.auth}
    restart: unless-stopped
    depends_on: { db: { condition: service_healthy } }
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      API_EXTERNAL_URL: http://127.0.0.1:${s.ports.api}/auth/v1
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:${DB_PASSWORD}@db:5432/postgres
      GOTRUE_SITE_URL: ${JSON.stringify(s.site)}
      GOTRUE_URI_ALLOW_LIST: ${JSON.stringify(s.redirects.join(','))}
      GOTRUE_DISABLE_SIGNUP: "${!s.signup}"
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_EXP: ${s.jwtExpiry}
      GOTRUE_JWT_SECRET: ${JWT_SECRET}
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "true"
      GOTRUE_MAILER_AUTOCONFIRM: "${!s.confirm}"
      GOTRUE_SMTP_HOST: ${on('mail') ? 'mail' : 'localhost'}
      GOTRUE_SMTP_PORT: 1025
      GOTRUE_SMTP_ADMIN_EMAIL: noreply@localhost
      GOTRUE_SMTP_SENDER_NAME: StitchDB local
      GOTRUE_MAILER_URLPATHS_INVITE: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_RECOVERY: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: /auth/v1/verify
      GOTRUE_RATE_LIMIT_EMAIL_SENT: 1000`);
  if (on('rest')) svc.push(`  rest:
    image: ${IMAGES.rest}
    restart: unless-stopped
    depends_on: { db: { condition: service_healthy } }
    environment:
      PGRST_DB_URI: postgres://authenticator:${DB_PASSWORD}@db:5432/postgres
      PGRST_DB_SCHEMAS: ${JSON.stringify(s.schemas.join(','))}
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: "false"
      PGRST_APP_SETTINGS_JWT_SECRET: ${JWT_SECRET}
      PGRST_APP_SETTINGS_JWT_EXP: ${s.jwtExpiry}
    command: ["postgrest"]`);
  if (on('realtime')) svc.push(`  realtime:
    image: ${IMAGES.realtime}
    restart: unless-stopped
    depends_on: { db: { condition: service_healthy } }
    networks:
      default:
        aliases: [realtime-dev.stitchdb-realtime]
    environment:
      PORT: 4000
      DB_HOST: db
      DB_PORT: 5432
      DB_USER: supabase_admin
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: postgres
      DB_AFTER_CONNECT_QUERY: 'SET search_path TO _realtime'
      DB_ENC_KEY: stitchdbrealtime
      API_JWT_SECRET: ${JWT_SECRET}
      SECRET_KEY_BASE: ${crypto.createHash('sha512').update(JWT_SECRET).digest('hex')}
      METRICS_JWT_SECRET: ${JWT_SECRET}
      ERL_AFLAGS: -proto_dist inet_tcp
      DNS_NODES: "''"
      RLIMIT_NOFILE: "10000"
      APP_NAME: realtime
      SEED_SELF_HOST: "true"
      RUN_JANITOR: "true"`);
  if (on('storage')) svc.push(`  storage:
    image: ${IMAGES.storage}
    restart: unless-stopped
    depends_on: { db: { condition: service_healthy } }
    environment:
      ANON_KEY: ${KEYS.anon}
      SERVICE_KEY: ${KEYS.service}
      POSTGREST_URL: http://rest:3000
      PGRST_JWT_SECRET: ${JWT_SECRET}
      AUTH_JWT_SECRET: ${JWT_SECRET}
      DATABASE_URL: postgres://supabase_storage_admin:${DB_PASSWORD}@db:5432/postgres
      FILE_SIZE_LIMIT: 52428800
      STORAGE_BACKEND: file
      FILE_STORAGE_BACKEND_PATH: /var/lib/storage
      TENANT_ID: stub
      REGION: local
      GLOBAL_S3_BUCKET: stub
      ENABLE_IMAGE_TRANSFORMATION: "false"
    volumes:
      - storage-data:/var/lib/storage`);
  if (on('meta')) svc.push(`  meta:
    image: ${IMAGES.meta}
    restart: unless-stopped
    depends_on: { db: { condition: service_healthy } }
    environment:
      PG_META_PORT: 8080
      PG_META_DB_HOST: db
      PG_META_DB_PORT: 5432
      PG_META_DB_NAME: postgres
      PG_META_DB_USER: postgres
      PG_META_DB_PASSWORD: ${DB_PASSWORD}`);
  if (on('functions')) svc.push(`  functions:
    image: ${IMAGES.functions}
    restart: unless-stopped
    volumes:
      - type: bind
        source: ${JSON.stringify(fnDir)}
        target: /home/deno/functions
        read_only: true
      - ./functions-main:/home/deno/main:ro
    env_file: [./functions.env]
    environment:
      JWT_SECRET: ${JWT_SECRET}
      STITCHDB_URL: http://gateway:8000
      STITCHDB_ANON_KEY: ${KEYS.anon}
      STITCHDB_SERVICE_ROLE_KEY: ${KEYS.service}
      STITCHDB_DB_URL: postgresql://postgres:${DB_PASSWORD}@db:5432/postgres
      STITCHDB_PROJECT_REF: local
      SUPABASE_URL: http://gateway:8000
      SUPABASE_ANON_KEY: ${KEYS.anon}
      SUPABASE_SERVICE_ROLE_KEY: ${KEYS.service}
      SUPABASE_DB_URL: postgresql://postgres:${DB_PASSWORD}@db:5432/postgres
    command: ["start", "--main-service", "/home/deno/main"]`);
  if (on('mail')) svc.push(`  mail:
    image: ${IMAGES.mail}
    restart: unless-stopped
    ports: [${bind(s.ports.mail, 8025)}]`);
  svc.push(`  gateway:
    image: ${IMAGES.gateway}
    restart: unless-stopped
    ports: [${bind(s.ports.api, 8000)}${on('studio') ? `, ${bind(s.ports.studio, 3000)}` : ''}]
    volumes:
      - ./gateway.conf:/etc/nginx/nginx.conf:ro
      - ./studio:/usr/share/nginx/studio:ro`);
  return `# Generated by the stitchdb CLI for ${proj.id} - do not edit (re-generated on every "stitchdb start").
name: ${s.name}
services:
${svc.join('\n')}
volumes:
  db-data:
  db-config:
  storage-data:
`;
}

function gatewayConf(exclude) {
  const on = (svc) => !exclude.includes(svc);
  const up = (name, port, loc, target, extra = '', host = '$host') => `    location ${loc} {
      set $u http://${name}:${port};
      rewrite ^${loc}(.*)$ ${target}$1 break;
      proxy_pass $u;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host ${host};
      proxy_set_header X-Forwarded-Proto http;
      proxy_read_timeout 3600s;
      ${extra}
    }`;
  return `# Generated by the stitchdb CLI - do not edit.
events {}
http {
  resolver 127.0.0.11 valid=5s ipv6=off;
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  map $http_authorization $sdb_auth { "" "Bearer $http_apikey"; default $http_authorization; }
  client_max_body_size 50m;
  server {
    listen 8000;
    add_header Access-Control-Allow-Origin * always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "authorization, apikey, content-type, x-client-info, prefer, range, accept-profile, content-profile, x-upsert, cache-control, x-stitch-read" always;
    add_header Access-Control-Expose-Headers "content-range, content-length, content-type, location, x-total-count" always;
    if ($request_method = OPTIONS) { return 204; }
    location = / { default_type application/json; return 200 '{"status":"ok","local":true}'; }
${on('rest') ? up('rest', 3000, '/rest/v1/', '/', 'proxy_set_header Authorization $sdb_auth;') : ''}
${on('auth') ? up('auth', 9999, '/auth/v1/', '/') : ''}
${on('storage') ? up('storage', 5000, '/storage/v1/', '/', 'proxy_set_header X-Forwarded-Prefix /storage/v1; proxy_request_buffering off;') : ''}
${on('realtime') ? up('realtime-dev.stitchdb-realtime', 4000, '/realtime/v1/api/', '/api/', '', 'realtime-dev.stitchdb-realtime') : ''}
${on('realtime') ? up('realtime-dev.stitchdb-realtime', 4000, '/realtime/v1/', '/socket/', '', 'realtime-dev.stitchdb-realtime') : ''}
${on('functions') ? up('functions', 9000, '/functions/v1/', '/') : ''}
${on('meta') ? `    location /pg/ {
      if ($http_apikey != "${KEYS.service}") { return 401; }
      set $u http://meta:8080;
      rewrite ^/pg/(.*)$ /$1 break;
      proxy_pass $u;
    }` : ''}
  }
  server {
    listen 3000;
    root /usr/share/nginx/studio;
    location / { try_files $uri /index.html; }
  }
}
`;
}

const TEMPLATES = path.join(__dirname, '..', 'templates');
function writeStack(proj, s, exclude) {
  fs.mkdirSync(s.dir, { recursive: true });
  for (const f of ['roles.sql', 'jwt.sql', 'realtime.sql']) writeFileSafe(path.join(s.dir, 'db', f), fs.readFileSync(path.join(TEMPLATES, 'local', 'db', f), 'utf8'));
  writeFileSafe(path.join(s.dir, 'functions-main', 'index.ts'), fs.readFileSync(path.join(TEMPLATES, 'local', 'functions-main.ts'), 'utf8'));
  // Per-function settings from config.toml ([functions.<name>] verify_jwt = false).
  const fnCfg = Object.fromEntries(Object.entries(proj.cfg.functions || {}).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, { verify_jwt: v.verify_jwt !== false }]));
  writeFileSafe(path.join(s.dir, 'functions-main', 'functions.json'), JSON.stringify(fnCfg, null, 2));
  const envFile = path.join(proj.functionsDir, '.env');
  writeFileSafe(path.join(s.dir, 'functions.env'), fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '');
  fs.mkdirSync(proj.functionsDir, { recursive: true });
  const studio = fs.readFileSync(path.join(TEMPLATES, 'local', 'studio.html'), 'utf8')
    .replace(/__API_URL__/g, `http://127.0.0.1:${s.ports.api}`).replace(/__SERVICE_KEY__/g, KEYS.service).replace(/__ANON_KEY__/g, KEYS.anon)
    .replace(/__MAIL_URL__/g, exclude.includes('mail') ? '' : `http://127.0.0.1:${s.ports.mail}`).replace(/__PROJECT__/g, proj.id);
  writeFileSafe(path.join(s.dir, 'studio', 'index.html'), studio);
  writeFileSafe(path.join(s.dir, 'docker-compose.yml'), compose(proj, s, exclude));
  writeFileSafe(path.join(s.dir, 'gateway.conf'), gatewayConf(exclude));
  writeFileSafe(path.join(s.dir, 'exclude.json'), JSON.stringify(exclude));
}
const dc = (s, args, opts) => run('docker', ['compose', '-p', s.name, '-f', path.join(s.dir, 'docker-compose.yml'), ...args], opts);

function status(proj) {
  const s = settings(proj);
  if (!fs.existsSync(path.join(s.dir, 'docker-compose.yml'))) return { running: false, services: [], s };
  const r = dc(s, ['ps', '--all', '--format', 'json'], { allowFail: true });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  let rows = [];
  for (const l of lines) { try { const x = JSON.parse(l); rows = rows.concat(Array.isArray(x) ? x : [x]); } catch {} }
  const services = rows.map((x) => ({ service: x.Service, state: x.State, health: x.Health || '' }));
  return { running: services.some((x) => x.service === 'db' && x.state === 'running'), services, s };
}

// ---------- SQL inside the local database container ----------
function psql(s, sql, { db = 'postgres', user = 'postgres', json = false } = {}) {
  const args = ['exec', '-T', '-e', `PGPASSWORD=${DB_PASSWORD}`, 'db', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', 'localhost', '-U', user, '-d', db];
  if (json) args.push('-At');
  const r = dc(s, args, { input: sql, allowFail: true });
  if (r.status !== 0) { const e = new Error((r.stderr || r.stdout || '').trim().replace(/^psql:<stdin>:\d+: /gm, '')); e.sqlError = true; throw e; }
  return r.stdout;
}
function queryJson(s, sql) {
  const out = psql(s, `select coalesce(json_agg(t), '[]'::json) from (${sql.replace(/;\s*$/, '')}) t;`, { json: true });
  return JSON.parse(out.trim() || '[]');
}
const HISTORY = `create schema if not exists stitchdb_migrations;
create table if not exists stitchdb_migrations.schema_migrations (version text primary key, name text not null default '', checksum text not null,
  statements text not null, applied_at timestamptz not null default now(), applied_by text, duration_ms int);`;
const dollar = (text) => { let tag; do tag = `$m${crypto.randomBytes(4).toString('hex')}$`; while (text.includes(tag)); return `${tag}${text}${tag}`; };
function localHistory(s) {
  psql(s, HISTORY);
  return queryJson(s, 'select version, name, checksum, applied_at from stitchdb_migrations.schema_migrations order by version::numeric');
}
const RAW_RE = /(^|;)\s*(begin|start\s+transaction|commit|rollback|end|savepoint|vacuum|create\s+database|alter\s+system)\b|\bconcurrently\b/i;
function applyLocal(s, migrations, { by = 'local' } = {}) {
  psql(s, HISTORY);
  const done = [];
  for (const m of migrations) {
    const rec = `insert into stitchdb_migrations.schema_migrations (version, name, checksum, statements, applied_by) values ('${m.version}', '${m.name}', '${m.checksum}', ${dollar(m.sql)}, '${by}') on conflict (version) do nothing;`;
    const raw = RAW_RE.test(m.sql.replace(/--[^\n]*/g, '').replace(/'(?:''|[^'])*'/g, "''"));
    try { psql(s, raw ? `${m.sql}\n;\n${rec}` : `begin;\n${m.sql}\n;\n${rec}\ncommit;`); }
    catch (e) { const err = new Error(`Migration ${m.version}${m.name ? '_' + m.name : ''} failed: ${e.message}`); err.migration = m; throw err; }
    done.push(m);
  }
  if (done.length) psql(s, `notify pgrst, 'reload schema';`);
  return done;
}

// ---------- dumps (local container, or a throwaway shadow container) ----------
const INTERNAL = ['auth', 'storage', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'vault', 'cron', 'pgmq', 'net', 'pgsodium', 'pgsodium_masks',
  'stitchdb_bridge', 'stitchdb_migrations', 'supabase_functions', 'supabase_migrations', 'information_schema', 'pgbouncer', 'topology'];
const extensionsSql = `select coalesce(string_agg(format('create extension if not exists %I with schema %s;', e.extname, case when n.nspname = 'public' then 'public' else 'extensions' end), E'\\n' order by e.extname), '')
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname not in ('plpgsql', 'dblink')`;
const userSchemasSql = `select nspname from pg_namespace where nspname !~ '^pg_' and not (nspname = any(array[${INTERNAL.map((x) => `'${x}'`).join(',')}])) order by 1`;
function dumpWith(execArgs, schemas, { dataOnly = false } = {}) {
  if (!schemas.length) return '';
  const args = [...execArgs, 'pg_dump', '-U', 'supabase_admin', '-h', 'localhost', '-d', 'postgres', '--no-owner', '--no-publications', '--no-subscriptions', '--no-comments', dataOnly ? '--data-only' : '--schema-only'];
  for (const x of schemas) args.push('-n', x);
  return run('docker', args).stdout;
}
function dumpLocal(s, { dataOnly = false, schemas } = {}) {
  const all = queryJson(s, userSchemasSql).map((r) => r.nspname);
  const list = schemas?.length ? schemas.filter((x) => all.includes(x)) : all;
  const ext = dataOnly ? '' : psql(s, extensionsSql + ';', { json: true }).trim();
  return (ext ? ext + '\n\n' : '') + sanitize(dumpWith(['compose', '-p', s.name, '-f', path.join(s.dir, 'docker-compose.yml'), 'exec', '-T', '-e', `PGPASSWORD=${DB_PASSWORD}`, 'db'], list, { dataOnly }));
}
// Same rules as the server's sanitizer (lib/mgmt-api.js).
function sanitize(text) {
  let inCopy = false;
  return text.split('\n').map((l) => {
    if (inCopy) { if (l === '\\.') inCopy = false; return l; }
    if (/^COPY .* FROM stdin;$/.test(l)) { inCopy = true; return l; }
    if (/^\\(restrict|unrestrict)\b/.test(l)) return null;
    if (/^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)\b/.test(l) && /\bp_[a-z]{16}_[a-z]+\b/.test(l)) return null;
    if (/^ALTER .* OWNER TO /.test(l)) return null;
    const cs = /^CREATE SCHEMA ("?[A-Za-z0-9_]+"?);$/.exec(l);
    return cs ? `CREATE SCHEMA IF NOT EXISTS ${cs[1]};` : l;
  }).filter((l) => l !== null).join('\n');
}

// A throwaway Postgres (same image) with the local migrations applied: the "shadow" database for diffs.
async function withShadow(migrations, fn) {
  requireDocker();
  const name = `stitchdb_shadow_${process.pid}_${Date.now().toString(36)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitchdb-shadow-'));
  for (const f of ['roles.sql', 'jwt.sql', 'realtime.sql']) fs.copyFileSync(path.join(TEMPLATES, 'local', 'db', f), path.join(dir, f));
  run('docker', ['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${DB_PASSWORD}`, '-e', 'POSTGRES_HOST=/var/run/postgresql', '-e', 'JWT_EXP=3600',
    '-v', `${dir}/realtime.sql:/docker-entrypoint-initdb.d/migrations/99-realtime.sql:ro`, '-v', `${dir}/roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro`,
    '-v', `${dir}/jwt.sql:/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:ro`, IMAGES.db, 'postgres', '-c', 'config_file=/etc/postgresql/postgresql.conf']);
  try {
    // Ready = the init scripts finished and the server restarted for real (pg_isready alone answers during init).
    for (let i = 0; ; i++) {
      const r = run('docker', ['exec', '-e', `PGPASSWORD=${DB_PASSWORD}`, name, 'psql', '-X', '-At', '-h', 'localhost', '-U', 'postgres', '-d', 'postgres', '-c', "select count(*) from pg_namespace where nspname = 'auth'"], { allowFail: true });
      if (r.status === 0 && r.stdout.trim() === '1') { await sleep(1500); break; }
      if (i > 90) fail('The shadow database did not start in time.');
      await sleep(1000);
    }
    const exec = ['exec', '-i', '-e', `PGPASSWORD=${DB_PASSWORD}`, name];
    const ps = (sql) => {
      const r = run('docker', [...exec, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', 'localhost', '-U', 'postgres', '-d', 'postgres', '-At'], { input: sql, allowFail: true });
      if (r.status !== 0) throw new Error((r.stderr || '').trim().replace(/^psql:<stdin>:\d+: /gm, ''));
      return r.stdout;
    };
    for (const m of migrations) {
      try { ps(m.sql); } catch (e) { fail(`Migration ${m.version}_${m.name} does not apply to a fresh database: ${e.message}`); }
    }
    const schemas = JSON.parse(ps(`select coalesce(json_agg(nspname), '[]') from (${userSchemasSql}) t`).trim() || '[]');
    const ext = ps(extensionsSql + ';').trim();
    return await fn({ dump: (o) => (ext ? ext + '\n\n' : '') + sanitize(dumpWith(exec, schemas, o)), schemas });
  } finally {
    run('docker', ['rm', '-f', name], { allowFail: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- lifecycle ----------
async function waitHealthy(s, exclude, { timeout = 240000 } = {}) {
  const t0 = Date.now();
  const checks = [['rest', '/rest/v1/'], ['auth', '/auth/v1/health'], ['storage', '/storage/v1/status']].filter(([svc]) => !exclude.includes(svc));
  for (;;) {
    let bad = null;
    for (const [svc, p] of checks) {
      try { const r = await fetch(`http://127.0.0.1:${s.ports.api}${p}`, { headers: { apikey: KEYS.anon } }); if (r.status >= 500) bad = svc; } catch { bad = svc; }
      if (bad) break;
    }
    if (!bad) return;
    if (Date.now() - t0 > timeout) fail(`${LABEL[bad]} did not become ready in time.`, { hint: `Check its logs: docker compose -p ${s.name} logs ${bad}` });
    await sleep(2000);
  }
}
function waitDb(s, { timeout = 240000 } = {}) {
  const t0 = Date.now();
  return (async () => {
    for (;;) {
      try { if (psql(s, "select count(*) from pg_namespace where nspname = 'auth';", { json: true }).trim() === '1') return; } catch {}
      if (Date.now() - t0 > timeout) fail('The local database did not start in time.', { hint: `docker compose -p ${s.name} logs db` });
      await sleep(1500);
    }
  })();
}

// Apply local migrations that the local database doesn't have yet (+ the seed on a fresh database).
function syncMigrations(proj, s, { seed }) {
  const local = require('./migrations').readLocal(proj.migrationsDir);
  const have = new Set(localHistory(s).map((r) => r.version));
  const todo = local.filter((m) => !have.has(m.version));
  if (todo.length) { applyLocal(s, todo); require('./util').ok(`Applied ${todo.length} migration${todo.length === 1 ? '' : 's'}.`); }
  if (seed && fs.existsSync(proj.seedFile) && fs.readFileSync(proj.seedFile, 'utf8').replace(/--[^\n]*/g, '').trim()) {
    try { psql(s, fs.readFileSync(proj.seedFile, 'utf8')); require('./util').ok('Seeded the database (seed.sql).'); }
    catch (e) { fail(`seed.sql failed: ${e.message}`); }
  }
  return todo.length;
}

module.exports = { syncMigrations, IMAGES, OPTIONAL, LABEL, KEYS, JWT_SECRET, DB_PASSWORD, dockerAvailable, requireDocker, settings, urls, writeStack, dc, status, psql, queryJson,
  localHistory, applyLocal, dumpLocal, sanitize, withShadow, waitHealthy, waitDb, compose, gatewayConf, userSchemasSql, INTERNAL, run };
