// Local Postgres from the native runtime: the database template (initdb + roles/schemas + the auth service's tables,
// built once per runtime and copied for every project, so a fresh database is ready in about a second), starting and
// stopping a server, and throwaway servers for diffs. Postgres refuses to run as root: as root (CI containers) the
// server runs as "nobody".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { fail, debug, sleep } = require('../util');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'local');
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
let nobody;
function runAs() {
  if (!isRoot()) return {};
  if (!nobody) {
    const u = spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }), g = spawnSync('id', ['-g', 'nobody'], { encoding: 'utf8' });
    if (u.status !== 0) fail('Postgres cannot run as root and there is no "nobody" user to run it as.', { hint: 'Run the CLI as a normal user.' });
    nobody = { uid: Number(u.stdout), gid: Number(g.stdout) };
  }
  return nobody;
}
function chownR(p) {
  const o = runAs();
  if (o.uid === undefined) return;
  spawnSync('chown', ['-R', `${o.uid}:${o.gid}`, p]);
}

// Short socket directories (Unix socket paths are limited to ~100 bytes).
function socketDir(key) {
  // /tmp, not $TMPDIR: socket paths are limited to 107 bytes, and as root "nobody" must reach the folder.
  const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  const d = path.join(base, `stitchdb-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  chownR(d);
  return d;
}

function conf({ port, sock, listen = '127.0.0.1', logFile }) {
  const c = {
    listen_addresses: listen, port, unix_socket_directories: sock, max_connections: 60, shared_buffers: '32MB', work_mem: '8MB',
    maintenance_work_mem: '64MB', synchronous_commit: 'off', max_wal_size: '256MB', wal_level: 'replica', max_wal_senders: 2,
    shared_preload_libraries: 'pg_stat_statements,pg_cron', 'cron.database_name': 'postgres', 'cron.use_background_workers': 'on',
    max_worker_processes: 16, timezone: 'UTC', log_timezone: 'UTC', 'log_min_messages': 'warning', log_min_error_statement: 'error',
  };
  if (logFile) Object.assign(c, { logging_collector: 'off' });
  return Object.entries(c).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

// Start a server on a data dir; resolves when it accepts connections on the socket. Returns the child process.
async function startServer(rt, data, { port, sock, listen, logFile, timeout = 60000 }) {
  stopStale(data);
  const log = logFile ? fs.openSync(logFile, 'a') : 'ignore';
  if (logFile) chownR(logFile);
  const child = spawn(rt.pgBin('postgres'), ['-D', data, ...conf({ port, sock, listen, logFile })], { stdio: ['ignore', log, log], ...runAs() });
  if (typeof log === 'number') fs.closeSync(log);
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 'signal'; });
  const t0 = Date.now();
  for (;;) {
    const r = spawnSync(rt.pgBin('pg_isready'), ['-q', '-h', sock, '-p', String(port), '-U', 'postgres'], { encoding: 'utf8' });
    if (r.status === 0) return child;
    if (exited !== null) fail(`Postgres stopped while starting (exit ${exited}).`, { hint: logFile ? `See ${logFile}` : undefined });
    if (Date.now() - t0 > timeout) { child.kill('SIGKILL'); fail('Postgres did not start in time.', { hint: logFile ? `See ${logFile}` : undefined }); }
    await sleep(100);
  }
}
function stopServer(child, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const t = setTimeout(() => child.kill('SIGQUIT'), timeout);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGINT'); // fast shutdown
  });
}
// A server left running by a crashed CLI: stop it before starting again.
function stopStale(data) {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(data, 'postmaster.pid'), 'utf8').split('\n')[0]); } catch { return; }
  if (!pid) return;
  try { process.kill(pid, 0); } catch { return; }
  debug('stopping a stale postgres', pid);
  try { process.kill(pid, 'SIGINT'); } catch { return; }
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { try { process.kill(pid, 0); } catch { return; } spawnSync('sleep', ['0.1']); }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

function psqlFile(rt, sock, port, file, user = 'postgres') {
  const r = spawnSync(rt.pgBin('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', String(port), '-U', user, '-d', 'postgres', '-f', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`Setting up the local database failed: ${(r.stderr || r.stdout || r.error?.message || `exit ${r.status ?? r.signal}`).trim().slice(-800)}`);
}

// Run the auth service's migrations against a server (the auth tables are part of the template).
function authMigrate(rt, sock, port) {
  const env = {
    PATH: process.env.PATH, GOTRUE_DB_DRIVER: 'postgres', DATABASE_URL: `postgres://supabase_auth_admin@localhost:${port}/postgres?host=${sock}&sslmode=disable`,
    GOTRUE_DB_MIGRATIONS_PATH: rt.authMigrations, GOTRUE_DB_NAMESPACE: 'auth', API_EXTERNAL_URL: 'http://127.0.0.1', GOTRUE_SITE_URL: 'http://localhost:3000',
    GOTRUE_JWT_SECRET: 'stitchdb-local-development-jwt-secret-not-for-production', GOTRUE_API_HOST: '127.0.0.1', PORT: '0', GOTRUE_LOG_LEVEL: 'error',
  };
  const r = spawnSync(rt.bin('auth'), ['migrate'], { encoding: 'utf8', env, cwd: path.dirname(rt.authMigrations) });
  if (r.status !== 0) fail(`Creating the auth tables failed: ${(r.stderr || r.stdout || r.error?.message || `exit ${r.status ?? r.signal}`).trim().slice(-800)}`);
}

const templateKey = (rt) => crypto.createHash('sha1').update(JSON.stringify(rt.version)).update(fs.readFileSync(path.join(TEMPLATES, 'init.sql')))
  .update(fs.readFileSync(path.join(TEMPLATES, 'after-auth.sql'))).digest('hex').slice(0, 12);

// The ready-made data directory every local database starts from (built once per runtime version and setup SQL).
async function template(rt, base) {
  const dir = path.join(base, `template-${templateKey(rt)}`);
  if (fs.existsSync(path.join(dir, 'PG_VERSION'))) return dir;
  const tmp = `${dir}.tmp${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  chownR(tmp);
  const r = spawnSync(rt.pgBin('initdb'), ['-D', tmp, '-U', 'postgres', '--auth-local=trust', '--auth-host=scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-instructions'], { encoding: 'utf8', ...runAs() });
  if (r.status !== 0) fail(`initdb failed: ${(r.stderr || r.stdout || r.error?.message || `exit ${r.status ?? r.signal}`).trim().slice(-800)}`);
  // Connections from other machines are never accepted (the server only listens on 127.0.0.1 anyway).
  fs.writeFileSync(path.join(tmp, 'pg_hba.conf'), 'local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n');
  chownR(tmp);
  const sock = socketDir(`template-${tmp}`);
  const port = 5432;
  let child = null;
  try {
    child = await startServer(rt, tmp, { port, sock, listen: '' });
    const init = path.join(sock, 'init.sql'), after = path.join(sock, 'after-auth.sql');
    fs.copyFileSync(path.join(TEMPLATES, 'init.sql'), init);
    fs.copyFileSync(path.join(TEMPLATES, 'after-auth.sql'), after);
    psqlFile(rt, sock, port, init);
    authMigrate(rt, sock, port);
    psqlFile(rt, sock, port, after);
  } catch (e) {
    if (child) await stopServer(child);
    child = null;
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally { if (child) await stopServer(child); fs.rmSync(sock, { recursive: true, force: true }); }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  // Templates of older runtime versions or setup SQL are no longer used.
  for (const d of fs.readdirSync(base)) if (/^template-/.test(d) && d !== path.basename(dir)) fs.rmSync(path.join(base, d), { recursive: true, force: true });
  return dir;
}

function copyTemplate(tpl, data) {
  fs.mkdirSync(path.dirname(data), { recursive: true });
  fs.rmSync(data, { recursive: true, force: true });
  fs.cpSync(tpl, data, { recursive: true });
  fs.rmSync(path.join(data, 'postmaster.pid'), { force: true });
  fs.chmodSync(data, 0o700);
  chownR(data);
}

// A throwaway server copied from the template (socket only, no TCP port): the "shadow" database for diffs.
async function shadow(rt, base, fn) {
  const tpl = await template(rt, base);
  const data = fs.mkdtempSync(path.join(base, 'shadow-'));
  copyTemplate(tpl, data);
  const sock = socketDir(`shadow-${data}`);
  const port = 5432;
  const child = await startServer(rt, data, { port, sock, listen: '' });
  try { return await fn({ sock, port }); }
  finally { await stopServer(child); fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(sock, { recursive: true, force: true }); }
}

module.exports = { template, copyTemplate, startServer, stopServer, stopStale, shadow, socketDir, runAs, isRoot, chownR };
