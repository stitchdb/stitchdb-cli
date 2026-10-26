// The local project's background process (started by `stitchdb start`, stopped by `stitchdb stop`): runs Postgres,
// and behind one gateway on http://127.0.0.1:<api port> the REST and auth servers (plain processes from the runtime),
// Storage, Realtime and the mail catcher (in this process), Edge Functions (one Deno process per function) and the
// local Studio. Everything but Postgres starts on its first request and the processes stop again after a while
// without requests (--eager starts them all at once and keeps them running).
//   node daemon.js <state.json>    (state.json is written by the CLI: paths, ports, settings)
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const PG = require('./postgres');
const { pool, verify, bearer, send, readJson } = require('./common');
const { createStorage } = require('./storage');
const { createRealtime } = require('./realtime');
const { createMail } = require('./mail');
const pg = require('../pg');

const stateFile = process.argv[2];
const S = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const LOG = path.join(S.dir, 'logs');
fs.mkdirSync(LOG, { recursive: true });
const log = (...a) => process.stdout.write(`${new Date().toISOString()} ${a.join(' ')}\n`);
const rt = { pgBin: (n) => path.join(S.runtime, 'pg', 'bin', n), bin: (n) => path.join(S.runtime, 'bin', n), authMigrations: path.join(S.runtime, 'auth', 'migrations') };
const on = (svc) => !S.exclude.includes(svc);
const IDLE = S.eager ? Infinity : (S.idleMinutes || 10) * 60000;

function writeState(patch) {
  const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.writeFileSync(stateFile, JSON.stringify({ ...cur, ...patch }, null, 2));
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function waitHttp(port, p, ms = 30000, child) {
  const t0 = Date.now();
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`exited with code ${child.exitCode}`);
    const ok = await new Promise((r) => { const q = http.get({ host: '127.0.0.1', port, path: p, timeout: 1000 }, (res) => { res.resume(); r(res.statusCode < 500); }); q.on('error', () => r(false)); q.on('timeout', () => { q.destroy(); r(false); }); });
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error('did not become ready in time');
    await new Promise((r) => setTimeout(r, 80));
  }
}

// A process that starts on first use and stops after IDLE without requests.
function lazy(name, start) {
  let cur = null, last = 0, starting = null;
  const self = {
    name,
    async ensure() {
      last = Date.now();
      if (cur && cur.child.exitCode === null) return cur.port;
      if (!starting) {
        starting = (async () => {
          const t0 = Date.now();
          const port = await freePort();
          const out = fs.openSync(path.join(LOG, `${name}.log`), 'a');
          const child = await start(port, out);
          fs.closeSync(out);
          child.on('exit', (code, sig) => { if (cur?.child === child) cur = null; if (code && !sig) log(name, 'exited', code); });
          try { await child.ready(port); } catch (e) { child.kill('SIGKILL'); throw new Error(`${name} ${e.message} (see ${path.join(LOG, `${name}.log`)})`); }
          cur = { child, port };
          log(name, `started in ${Date.now() - t0} ms on ${port}`);
          return port;
        })().finally(() => { starting = null; });
      }
      return starting;
    },
    touch() { last = Date.now(); },
    idle() { if (cur && Date.now() - last > IDLE) { log(name, 'idle, stopping'); self.stop(); } },
    stop() { const c = cur; cur = null; if (c) return new Promise((r) => { c.child.once('exit', r); c.child.kill('SIGTERM'); setTimeout(() => c.child.kill('SIGKILL'), 5000).unref(); }); return Promise.resolve(); },
    state() { return cur ? 'running' : starting ? 'starting' : 'sleeping'; },
  };
  return self;
}
const proc = (cmd, args, env, out, ready) => { const c = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', out, out], cwd: S.dir }); c.ready = (port) => ready(port, c); return c; };

const dbUrl = (user) => `postgres://${user}:postgres@127.0.0.1:${S.ports.db}/postgres?sslmode=disable`;
const API = `http://127.0.0.1:${S.ports.api}`;

const rest = lazy('rest', (port, out) => proc(rt.bin('postgrest'), [], {
  PGRST_DB_URI: dbUrl('authenticator'), PGRST_DB_SCHEMAS: S.settings.schemas.join(','), PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: S.jwtSecret,
  PGRST_DB_EXTRA_SEARCH_PATH: S.settings.extraSearchPath.join(','), PGRST_DB_MAX_ROWS: String(S.settings.maxRows || ''), PGRST_DB_POOL: '6',
  PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(port), PGRST_DB_USE_LEGACY_GUCS: 'false', PGRST_LOG_LEVEL: 'warn',
  PGRST_APP_SETTINGS_JWT_SECRET: S.jwtSecret, PGRST_APP_SETTINGS_JWT_EXP: String(S.settings.jwtExpiry),
}, out, (p, c) => waitHttp(p, '/', 30000, c)));

const auth = lazy('auth', (port, out) => proc(rt.bin('auth'), [], {
  GOTRUE_API_HOST: '127.0.0.1', PORT: String(port), GOTRUE_API_PORT: String(port), API_EXTERNAL_URL: `${API}/auth/v1`, GOTRUE_DB_DRIVER: 'postgres', DATABASE_URL: dbUrl('supabase_auth_admin'),
  GOTRUE_DB_MIGRATIONS_PATH: rt.authMigrations, GOTRUE_DB_NAMESPACE: 'auth',
  GOTRUE_SITE_URL: S.settings.site, GOTRUE_URI_ALLOW_LIST: S.settings.redirects.join(','), GOTRUE_DISABLE_SIGNUP: String(!S.settings.signup),
  GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_EXP: String(S.settings.jwtExpiry),
  GOTRUE_JWT_SECRET: S.jwtSecret, GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'true', GOTRUE_MAILER_AUTOCONFIRM: String(!S.settings.confirm),
  GOTRUE_SMTP_HOST: '127.0.0.1', GOTRUE_SMTP_PORT: String(S.ports.smtp), GOTRUE_SMTP_ADMIN_EMAIL: 'noreply@localhost', GOTRUE_SMTP_SENDER_NAME: 'StitchDB local',
  GOTRUE_MAILER_URLPATHS_INVITE: '/auth/v1/verify', GOTRUE_MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify', GOTRUE_MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
  GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify', GOTRUE_RATE_LIMIT_EMAIL_SENT: '1000', GOTRUE_LOG_LEVEL: 'warn',
}, out, (p, c) => waitHttp(p, '/health', 30000, c)));

// ---------- Edge Functions (one Deno process per function, restarted by Deno when its files change) ----------
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const fns = new Map();
const WRAPPER = path.join(__dirname, '..', '..', 'templates', 'local', 'function-runner.ts');
function readEnvFile() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(S.functionsDir, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return env;
}
function fnFor(slug) {
  if (fns.has(slug)) return fns.get(slug);
  const dir = path.join(S.functionsDir, slug);
  const f = lazy(`function-${slug}`, async (port, out) => {
    S.deno ||= await require('../runtime').deno(); // first function request: download Deno once (unless installed)
    const args = ['run', '--allow-all', '--no-prompt', '--watch', '--no-clear-screen'];
    for (const c of ['deno.json', 'deno.jsonc']) if (fs.existsSync(path.join(dir, c))) { args.push('--config', path.join(dir, c)); break; }
    if (fs.existsSync(path.join(dir, 'import_map.json'))) args.push('--import-map', path.join(dir, 'import_map.json'));
    args.push(WRAPPER);
    const keys = { STITCHDB_URL: API, STITCHDB_ANON_KEY: S.keys.anon, STITCHDB_SERVICE_ROLE_KEY: S.keys.service, STITCHDB_DB_URL: dbUrl('postgres'), STITCHDB_PROJECT_REF: 'local' };
    const env = { ...readEnvFile(), ...keys, SUPABASE_URL: API, SUPABASE_ANON_KEY: S.keys.anon, SUPABASE_SERVICE_ROLE_KEY: S.keys.service, SUPABASE_DB_URL: dbUrl('postgres'),
      STITCHDB_FUNCTION_SLUG: slug, STITCHDB_FUNCTION_PORT: String(port), STITCHDB_FUNCTION_ENTRY: `file://${path.join(dir, 'index.ts')}`, DENO_DIR: S.denoDir, NO_COLOR: '1' };
    const c = spawn(S.deno, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
    const tee = (d) => { fs.appendFileSync(path.join(LOG, 'functions.log'), d.toString().split('\n').filter(Boolean).map((l) => `[${slug}] ${l}\n`).join('')); };
    c.stdout.on('data', tee); c.stderr.on('data', tee);
    c.ready = (p) => waitHttp(p, `/${slug}/__stitchdb_ready`, 120000, c);
    return c;
  });
  fns.set(slug, f);
  return f;
}
const fnSettings = () => S.settings.functions || {};

// ---------- proxy ----------
function proxy(req, res, port, target, headers = {}, retry = 0) {
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: target, headers: { ...req.headers, ...headers, host: `127.0.0.1:${S.ports.api}`, 'x-forwarded-proto': 'http', 'x-forwarded-host': `127.0.0.1:${S.ports.api}` } }, (r) => {
    res.writeHead(r.statusCode, r.statusMessage, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    // A function's Deno restarts while its files change: retry for a few seconds.
    if (e.code === 'ECONNREFUSED' && retry < 40 && req.method === 'GET') return setTimeout(() => proxy(req, res, port, target, headers, retry + 1), 150);
    send(res, 502, { message: `Local service unavailable: ${e.message}` });
  });
  req.pipe(up);
}

// ---------- Studio API (/pg) ----------
let db, storage, realtime, mail;
async function studioApi(req, res, sub) {
  if (req.headers.apikey !== S.keys.service) return send(res, 401, { message: 'The local Studio API needs the service_role key' });
  const url = new URL(sub, 'http://local');
  if (url.pathname === '/query' && req.method === 'POST') {
    const { query } = await readJson(req);
    try {
      const r = await db.query(String(query || ''), null);
      return send(res, 200, r.rows);
    } catch (e) { return send(res, 400, { error: e.message, message: e.message, code: e.code }); }
  }
  if (url.pathname === '/tables' && req.method === 'GET') {
    const schemas = (url.searchParams.get('included_schemas') || 'public').split(',');
    const r = await db.query(`select n.nspname as schema, c.relname as name, c.relrowsecurity as rls_enabled, c.reltuples::bigint as live_rows_estimate
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname = any($1::text[]) order by 1, 2`, [`{${schemas.map((s) => `"${s.replace(/"/g, '')}"`).join(',')}}`]);
    return send(res, 200, r.rows);
  }
  send(res, 404, { message: 'Not found' });
}

// ---------- gateway ----------
const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, prefer, range, accept-profile, content-profile, x-upsert, cache-control, x-stitch-read, x-metadata, x-org-id, x-region',
  'access-control-expose-headers': 'content-range, content-length, content-type, location, x-total-count, etag',
};
async function gateway(req, res) {
  const origWrite = res.writeHead.bind(res);
  res.writeHead = (status, a, b) => { for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v); return origWrite(status, a, b); };
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = req.url;
  const m = /^\/(rest|auth|storage|realtime|functions)\/v1(\/.*)?$/.exec(u.split('?')[0]);
  const rest_ = u.slice(u.indexOf('/v1') + 3) || '/';
  try {
    if (u === '/' || u.startsWith('/?')) return send(res, 200, { status: 'ok', local: true, project: S.project });
    if (u.startsWith('/__stitchdb/status')) return send(res, 200, status());
    if (u.startsWith('/pg/')) return await studioApi(req, res, u.slice(3));
    if (!m) return send(res, 404, { message: 'Not found' });
    const svc = m[1];
    if (!on(svc)) return send(res, 503, { message: `${svc} is turned off for this local project (stitchdb start -x)` });
    const authz = req.headers.authorization || (req.headers.apikey ? `Bearer ${req.headers.apikey}` : undefined);
    if (svc === 'rest') return proxy(req, res, await rest.ensure(), rest_, authz ? { authorization: authz } : {});
    if (svc === 'auth') return proxy(req, res, await auth.ensure(), rest_);
    if (svc === 'storage') return storage.handle(req, res, rest_);
    if (svc === 'realtime') return realtime.handle(req, res, rest_);
    if (svc === 'functions') {
      const [, slug = ''] = rest_.split('?')[0].split('/');
      if (!SLUG_RE.test(slug) || !fs.existsSync(path.join(S.functionsDir, slug, 'index.ts'))) return send(res, 404, { code: 'NOT_FOUND', message: `Function "${slug}" was not found in stitchdb/functions/${slug}/index.ts` });
      if (fnSettings()[slug]?.verify_jwt !== false) {
        const t = bearer(req);
        if (!t) return send(res, 401, { code: 'UNAUTHORIZED_NO_AUTH_HEADER', message: 'Missing authorization header' });
        if (!verify(t, S.jwtSecret)) return send(res, 401, { code: 'UNAUTHORIZED_INVALID_JWT', message: 'Invalid JWT' });
      }
      return proxy(req, res, await fnFor(slug).ensure(), rest_);
    }
  } catch (e) {
    log('gateway', e.stack || e.message);
    send(res, 503, { message: e.message });
  }
}
function upgrade(req, socket, head) {
  if (/^\/realtime\/v1\/(socket\/)?websocket/.test(req.url) && on('realtime')) return realtime.upgrade(req, socket, head);
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function status() {
  return {
    pid: process.pid, project: S.project, started_at: S.started_at,
    services: [
      { service: 'db', state: 'running' },
      ...[['rest', rest], ['auth', auth]].filter(([n]) => on(n)).map(([n, x]) => ({ service: n, state: x.state() })),
      ...(on('storage') ? [{ service: 'storage', state: 'running' }] : []),
      ...(on('realtime') ? [{ service: 'realtime', state: 'running', ...realtime.stats() }] : []),
      ...(on('functions') ? [{ service: 'functions', state: [...fns.values()].some((f) => f.state() === 'running') ? 'running' : 'sleeping', running: [...fns.entries()].filter(([, f]) => f.state() === 'running').map(([k]) => k) }] : []),
      ...(on('mail') ? [{ service: 'mail', state: 'running', messages: mail.messages.length }] : []),
      ...(on('studio') ? [{ service: 'studio', state: 'running' }] : []),
    ],
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

// ---------- lifecycle ----------
let pgChild, servers = [];
async function shutdown(sig) {
  log('stopping', sig || '');
  for (const s of servers) s.close();
  await Promise.all([rest.stop(), auth.stop(), ...[...fns.values()].map((f) => f.stop())]);
  await realtime?.close().catch(() => {});
  await db?.end().catch(() => {});
  await PG.stopServer(pgChild);
  writeState({ pid: null, ready: false, stopped_at: new Date().toISOString() });
  process.exit(0);
}

async function main() {
  const sock = PG.socketDir(`db-${S.dir}`);
  pgChild = await PG.startServer(rt, S.data, { port: S.ports.db, sock, listen: '127.0.0.1', logFile: path.join(LOG, 'postgres.log') });
  pgChild.on('exit', (code) => { log('postgres exited', code); if (!stopping) process.exit(1); });
  db = pool({ sock, port: S.ports.db, size: 8 });
  // The local JWT settings, for SQL that signs or reads tokens.
  await db.query(`alter database postgres set "app.settings.jwt_exp" to '${Number(S.settings.jwtExpiry) || 3600}'`).catch(() => {});
  storage = createStorage({ db, dir: S.dir, secret: S.jwtSecret, apiUrl: API, fileLimit: S.settings.fileLimit });
  realtime = createRealtime({ db, secret: S.jwtSecret, connectListener: () => pg.connect({ socket: sock, port: S.ports.db, user: 'postgres', application_name: 'stitchdb-realtime' }) });
  mail = createMail();

  const listen = (srv, port) => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', () => { servers.push(srv); resolve(); }); });
  const gw = http.createServer(gateway);
  gw.on('upgrade', upgrade);
  gw.keepAliveTimeout = 65000;
  await listen(gw, S.ports.api);
  if (on('mail')) { await listen(mail.smtp, S.ports.smtp); await listen(http.createServer(mail.handle), S.ports.mail); }
  if (on('studio')) {
    const page = fs.readFileSync(path.join(S.dir, 'studio.html'));
    await listen(http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(page); }), S.ports.studio);
  }
  setInterval(() => { rest.idle(); auth.idle(); for (const f of fns.values()) f.idle(); }, 30000).unref();
  if (S.eager) await Promise.all([on('rest') && rest.ensure(), on('auth') && auth.ensure()].filter(Boolean));
  writeState({ pid: process.pid, ready: true, error: null });
  log('ready on', API);
}
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { if (stopping) return; stopping = true; shutdown(sig); });
main().catch((e) => { log('failed:', e.stack || e.message); try { writeState({ pid: null, ready: false, error: e.message }); } catch {} stopping = true; PG.stopServer(pgChild).finally(() => process.exit(1)); });
