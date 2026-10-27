// Local development (stitchdb start/stop/status, db reset, local migrations, types and diffs) on the native runtime:
// plain processes, no Docker. Each project folder (each git worktree) is its own local project with its own data and
// ports, so several run side by side: the CLI takes the ports from config.toml when they are free and otherwise picks
// free ones, and remembers them for that folder. A background process (lib/native/daemon.js) runs Postgres and, behind
// one gateway on http://127.0.0.1:<api port>, Auth, REST, Storage, Realtime, Edge Functions, the local Studio and a
// mail catcher; everything but Postgres starts on its first request. Every port binds to 127.0.0.1 only.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { fail, debug, sleep, writeFileSafe } = require('./util');
const R = require('./runtime');
const PG = require('./native/postgres');

const OPTIONAL = ['auth', 'rest', 'realtime', 'storage', 'functions', 'mail', 'studio'];
const LABEL = { db: 'Database', auth: 'Auth', rest: 'REST API', realtime: 'Realtime', storage: 'Storage', functions: 'Edge Functions', mail: 'Mail catcher', studio: 'Studio' };

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

// ---------- configuration ----------
const BASE = () => path.join(R.dataHome(), 'local');
function settings(proj) {
  const cfg = proj.cfg || {};
  const key = crypto.createHash('sha1').update(path.resolve(proj.root)).digest('hex').slice(0, 8);
  const dir = path.join(BASE(), `${proj.id}-${key}`);
  const want = { api: cfg.api?.port || 54321, db: cfg.db?.port || 54322, studio: cfg.studio?.port || 54323, mail: cfg.inbucket?.port || cfg.mail?.port || 54324 };
  want.smtp = cfg.mail?.smtp_port || want.mail + 1;
  let ports = null;
  try { ports = JSON.parse(fs.readFileSync(path.join(dir, 'ports.json'), 'utf8')); } catch {}
  return {
    name: proj.id, root: proj.root, dir, data: path.join(dir, 'db'), stateFile: path.join(dir, 'state.json'), want, ports: ports || want,
    schemas: cfg.api?.schemas || ['public'], extraSearchPath: cfg.api?.extra_search_path || ['public', 'extensions'], maxRows: cfg.api?.max_rows || 1000,
    site: cfg.auth?.site_url || 'http://localhost:3000',
    redirects: cfg.auth?.additional_redirect_urls || [],
    jwtExpiry: cfg.auth?.jwt_expiry || 3600,
    signup: cfg.auth?.enable_signup !== false,
    confirm: cfg.auth?.email?.enable_confirmations === true,
    fileLimit: cfg.storage?.file_size_limit || '50MiB',
    functions: Object.fromEntries(Object.entries(cfg.functions || {}).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, { verify_jwt: v.verify_jwt !== false }])),
    idleMinutes: cfg.local?.idle_minutes || 10,
  };
}
const urls = (s) => ({
  api: `http://127.0.0.1:${s.ports.api}`, db: `postgresql://postgres:${DB_PASSWORD}@127.0.0.1:${s.ports.db}/postgres`,
  studio: `http://127.0.0.1:${s.ports.studio}`, mail: `http://127.0.0.1:${s.ports.mail}`,
  functions: `http://127.0.0.1:${s.ports.api}/functions/v1`,
});
const readState = (s) => { try { return JSON.parse(fs.readFileSync(s.stateFile, 'utf8')); } catch { return null; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------- ports ----------
const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});
// Ports remembered by the other local projects on this machine (running or not), so each keeps its own.
function claimed(s) {
  const out = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(BASE()); } catch {}
  for (const d of dirs) {
    if (path.join(BASE(), d) === s.dir) continue;
    try { for (const p of Object.values(JSON.parse(fs.readFileSync(path.join(BASE(), d, 'ports.json'), 'utf8')))) out.add(Number(p)); } catch {}
  }
  return out;
}
async function assignPorts(s) {
  const taken = claimed(s);
  const ok = async (ports) => { for (const p of Object.values(ports)) if (taken.has(p) || !(await portFree(p))) return false; return true; };
  let ports = null;
  const remembered = fs.existsSync(path.join(s.dir, 'ports.json')) ? s.ports : null;
  if (remembered && (await ok(remembered))) ports = remembered;
  else if (await ok(s.want)) ports = s.want;
  else {
    for (let base = 54421; base < 64000 && !ports; base += 10) {
      const p = { api: base, db: base + 1, studio: base + 2, mail: base + 3, smtp: base + 4 };
      if (await ok(p)) ports = p;
    }
    if (!ports) fail('No free ports for the local project.');
  }
  writeFileSafe(path.join(s.dir, 'ports.json'), JSON.stringify(ports, null, 2));
  s.ports = ports;
  return { ports, moved: !!remembered && JSON.stringify(remembered) !== JSON.stringify(ports) || (!remembered && JSON.stringify(ports) !== JSON.stringify(s.want)) };
}

// ---------- status ----------
const isRunning = (s) => { const st = readState(s); return !!(st?.ready && alive(st.pid)); };
async function status(proj) {
  const s = settings(proj);
  const st = readState(s);
  const running = !!(st?.ready && alive(st.pid));
  let services = [], memory = null;
  if (running) {
    try {
      const r = await fetch(`http://127.0.0.1:${s.ports.api}/__stitchdb/status`, { signal: AbortSignal.timeout(3000) }).then((x) => x.json());
      services = r.services; memory = r.memory_mb;
    } catch { services = [{ service: 'db', state: 'running' }]; }
  }
  return { running, services, s, state: st, memory_mb: memory, exclude: st?.exclude || [], hasData: fs.existsSync(path.join(s.data, 'PG_VERSION')) };
}

// ---------- start / stop ----------
const TEMPLATES = path.join(__dirname, '..', 'templates', 'local');
async function start(proj, { exclude = [], eager = false, onStep = () => {} } = {}) {
  const s = settings(proj);
  const st = readState(s);
  if (st?.pid && alive(st.pid)) await stop(proj);
  onStep('runtime');
  const rt = await R.ensure();
  fs.mkdirSync(s.dir, { recursive: true });
  const { moved } = await assignPorts(s);
  const fresh = !fs.existsSync(path.join(s.data, 'PG_VERSION'));
  if (fresh) {
    onStep('template');
    const tpl = await PG.template(rt, BASE());
    PG.copyTemplate(tpl, s.data);
  }
  // Deno only when there are functions to run (otherwise it is downloaded on the first function request).
  const fnDir = proj.functionsDir;
  fs.mkdirSync(fnDir, { recursive: true });
  let deno = null;
  if (!exclude.includes('functions') && fs.readdirSync(fnDir).some((d) => fs.existsSync(path.join(fnDir, d, 'index.ts')))) { onStep('deno'); deno = await R.deno(); }
  const studio = fs.readFileSync(path.join(TEMPLATES, 'studio.html'), 'utf8')
    .replace(/__API_URL__/g, `http://127.0.0.1:${s.ports.api}`).replace(/__SERVICE_KEY__/g, KEYS.service).replace(/__ANON_KEY__/g, KEYS.anon)
    .replace(/__MAIL_URL__/g, exclude.includes('mail') ? '' : `http://127.0.0.1:${s.ports.mail}`).replace(/__PROJECT__/g, proj.id);
  writeFileSafe(path.join(s.dir, 'studio.html'), studio);
  const state = {
    project: proj.id, root: proj.root, dir: s.dir, data: s.data, runtime: rt.dir, functionsDir: fnDir, ports: s.ports, exclude, eager, idleMinutes: s.idleMinutes,
    jwtSecret: JWT_SECRET, keys: KEYS, deno, denoDir: path.join(R.ROOT, 'deno-cache'),
    settings: { schemas: s.schemas, extraSearchPath: s.extraSearchPath, maxRows: s.maxRows, site: s.site, redirects: s.redirects, jwtExpiry: s.jwtExpiry, signup: s.signup, confirm: s.confirm, fileLimit: s.fileLimit, functions: s.functions },
    started_at: new Date().toISOString(), pid: null, ready: false, error: null,
  };
  writeFileSafe(s.stateFile, JSON.stringify(state, null, 2));
  onStep('daemon');
  fs.mkdirSync(path.join(s.dir, 'logs'), { recursive: true });
  const out = fs.openSync(path.join(s.dir, 'logs', 'local.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'native', 'daemon.js'), s.stateFile], { detached: true, stdio: ['ignore', out, out], cwd: s.dir });
  fs.closeSync(out);
  child.unref();
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const t0 = Date.now();
  for (;;) {
    const cur = readState(s);
    if (cur?.ready) break;
    if (cur?.error || exited !== null) fail(`The local project did not start: ${cur?.error || `exit ${exited}`}`, { hint: `See ${path.join(s.dir, 'logs')}` });
    if (Date.now() - t0 > 90000) { try { process.kill(child.pid, 'SIGTERM'); } catch {} fail('The local project did not start in time.', { hint: `See ${path.join(s.dir, 'logs')}` }); }
    await sleep(50);
  }
  return { s, fresh, moved, ms: Date.now() - t0 };
}
// deleteData: the database and files go, the ports stay (db reset). forget: the whole local project goes (stop --no-backup).
async function stop(proj, { deleteData = false, forget = false } = {}) {
  const s = settings(proj);
  const st = readState(s);
  let stopped = false;
  if (st?.pid && alive(st.pid)) {
    process.kill(st.pid, 'SIGTERM');
    const t0 = Date.now();
    while (alive(st.pid) && Date.now() - t0 < 30000) await sleep(50);
    if (alive(st.pid)) process.kill(st.pid, 'SIGKILL');
    stopped = true;
  }
  if (fs.existsSync(s.data)) PG.stopStale(s.data);
  if (forget) fs.rmSync(s.dir, { recursive: true, force: true });
  else if (deleteData) for (const d of ['db', 'storage', 'logs']) fs.rmSync(path.join(s.dir, d), { recursive: true, force: true });
  return { stopped, s };
}

// ---------- SQL on the local database (psql from the runtime, over its socket) ----------
function rtDir() {
  const env = process.env.STITCHDB_RUNTIME_DIR;
  const dir = env ? path.resolve(env) : path.join(R.ROOT, `runtime-${R.RUNTIME.version}-${R.platform()}`);
  if (!fs.existsSync(path.join(dir, 'VERSION.json'))) fail('The local runtime is not installed yet.', { hint: 'Run "stitchdb start" first.' });
  return dir;
}
const pgBin = (n) => path.join(rtDir(), 'pg', 'bin', n);
const conn = (s) => ({ sock: s.sock || PG.socketDir(`db-${s.dir}`), port: s.sock ? s.port : s.ports.db });
function run(cmd, args, { input, allowFail = false } = {}) {
  debug('$', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) fail(`${path.basename(cmd)} failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${path.basename(cmd)} failed: ${(r.stderr || r.stdout || r.error?.message || `exit ${r.status ?? r.signal}`).trim().slice(-800)}`);
  return r;
}
function psql(s, sql, { db = 'postgres', user = 'postgres', json = false } = {}) {
  const c = conn(s);
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', c.sock, '-p', String(c.port), '-U', user, '-d', db];
  if (json) args.push('-At');
  const r = run(pgBin('psql'), args, { input: sql, allowFail: true });
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

// ---------- dumps (the local database, or a throwaway shadow database) ----------
const INTERNAL = ['auth', 'storage', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'vault', 'cron', 'pgmq', 'net', 'pgsodium', 'pgsodium_masks',
  'stitchdb_bridge', 'stitchdb_migrations', 'supabase_functions', 'supabase_migrations', 'information_schema', 'pgbouncer', 'topology'];
const extensionsSql = `select coalesce(string_agg(format('create extension if not exists %I with schema %s;', e.extname, case when n.nspname = 'public' then 'public' else 'extensions' end), E'\\n' order by e.extname), '')
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname not in ('plpgsql', 'dblink')`;
const userSchemasSql = `select nspname from pg_namespace where nspname !~ '^pg_' and not (nspname = any(array[${INTERNAL.map((x) => `'${x}'`).join(',')}])) order by 1`;
function dumpWith(s, schemas, { dataOnly = false } = {}) {
  if (!schemas.length) return '';
  const c = conn(s);
  const args = ['-h', c.sock, '-p', String(c.port), '-U', 'postgres', '-d', 'postgres', '--no-owner', '--no-publications', '--no-subscriptions', '--no-comments', dataOnly ? '--data-only' : '--schema-only'];
  for (const x of schemas) args.push('-n', x);
  return run(pgBin('pg_dump'), args).stdout;
}
function dumpLocal(s, { dataOnly = false, schemas } = {}) {
  const all = queryJson(s, userSchemasSql).map((r) => r.nspname);
  const list = schemas?.length ? schemas.filter((x) => all.includes(x)) : all;
  const ext = dataOnly ? '' : psql(s, extensionsSql + ';', { json: true }).trim();
  return (ext ? ext + '\n\n' : '') + sanitize(dumpWith(s, list, { dataOnly }));
}
// Same rules as the server's sanitizer (lib/mgmt-api.js), plus the local realtime triggers.
function sanitize(text) {
  let inCopy = false;
  return text.split('\n').map((l) => {
    if (inCopy) { if (l === '\\.') inCopy = false; return l; }
    if (/^COPY .* FROM stdin;$/.test(l)) { inCopy = true; return l; }
    if (/^\\(restrict|unrestrict)\b/.test(l)) return null;
    if (/^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)\b/.test(l) && /\bp_[a-z]{16}_[a-z]+\b/.test(l)) return null;
    if (/^ALTER .* OWNER TO /.test(l)) return null;
    if (/^CREATE TRIGGER stitchdb_realtime_local /.test(l) || /^-- Name: .* stitchdb_realtime_local; Type: TRIGGER;/.test(l)) return null;
    const cs = /^CREATE SCHEMA ("?[A-Za-z0-9_]+"?);$/.exec(l);
    return cs ? `CREATE SCHEMA IF NOT EXISTS ${cs[1]};` : l;
  }).filter((l) => l !== null).join('\n');
}

// A throwaway database (copied from the template, about a second) with `scripts` applied: [{version, name, sql}]
// (migrations, or declarative schema files). fn gets { dump(opts), schemas }.
async function withShadow(scripts, fn, { what = 'Migration' } = {}) {
  const rt = await R.ensure();
  return PG.shadow(rt, BASE(), async ({ sock, port }) => {
    const sh = { sock, port, dir: sock };
    for (const m of scripts) {
      try { psql(sh, m.sql); } catch (e) { fail(`${what} ${m.version ? `${m.version}_${m.name}` : m.name} does not apply to a fresh database: ${e.message}`); }
    }
    const schemas = queryJson(sh, userSchemasSql).map((r) => r.nspname);
    const ext = psql(sh, extensionsSql + ';', { json: true }).trim();
    return fn({ dump: (o) => (ext ? ext + '\n\n' : '') + sanitize(dumpWith(sh, schemas, o)), schemas });
  });
}

// Declarative schema files: stitchdb/schemas/**/*.sql (or [db] schema_paths in config.toml), in path order.
function schemaFiles(proj) {
  const globs = proj.cfg.db?.schema_paths;
  const roots = Array.isArray(globs) && globs.length ? globs.map((g) => path.resolve(proj.dir, g.replace(/\*.*$/, ''))) : [path.join(proj.dir, 'schemas')];
  const out = [];
  const walk = (d) => {
    let st; try { st = fs.statSync(d); } catch { return; }
    if (st.isFile()) { if (d.endsWith('.sql')) out.push(d); return; }
    for (const f of fs.readdirSync(d).sort()) walk(path.join(d, f));
  };
  for (const r of roots) walk(r);
  return [...new Set(out)].map((f) => ({ name: path.relative(proj.dir, f), sql: fs.readFileSync(f, 'utf8') }));
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

// Every local project on this machine (for "stitchdb status --all").
function allProjects() {
  let dirs = [];
  try { dirs = fs.readdirSync(BASE()); } catch {}
  return dirs.filter((d) => !d.startsWith('template-') && !d.startsWith('shadow-')).map((d) => {
    const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(BASE(), d, 'state.json'), 'utf8')); } catch { return null; } })();
    return st && { project: st.project, root: st.root, running: !!(st.ready && alive(st.pid)), api: `http://127.0.0.1:${st.ports.api}`, db_port: st.ports.db, dir: path.join(BASE(), d) };
  }).filter(Boolean);
}

module.exports = { syncMigrations, OPTIONAL, LABEL, KEYS, JWT_SECRET, DB_PASSWORD, settings, urls, status, start, stop, psql, queryJson,
  localHistory, applyLocal, dumpLocal, isRunning, readState, sanitize, withShadow, schemaFiles, userSchemasSql, INTERNAL, run, allProjects, assignPorts };
