// Local migration files: stitchdb/migrations/<version>_<name>.sql (same checksum rules as the server).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail, writeFileSafe } = require('./util');

const normalize = (sql) => String(sql ?? '').replace(/\r\n/g, '\n');
const checksum = (sql) => crypto.createHash('sha256').update(normalize(sql)).digest('hex');
const FILE_RE = /^([0-9]{1,20})(?:_([a-z0-9_]+))?\.sql$/i;
const slug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100);
const newVersion = (d = new Date()) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const cmp = (a, b) => (BigInt(a.version) < BigInt(b.version) ? -1 : BigInt(a.version) > BigInt(b.version) ? 1 : 0);

function readLocal(dir) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.sql')) continue;
    const m = FILE_RE.exec(f);
    if (!m) fail(`Migration file name "${f}" is not <version>_<name>.sql (for example ${newVersion()}_create_todos.sql).`);
    const sql = normalize(fs.readFileSync(path.join(dir, f), 'utf8'));
    out.push({ version: m[1], name: (m[2] || '').toLowerCase(), file: path.join(dir, f), sql, checksum: checksum(sql) });
  }
  const seen = new Set();
  for (const m of out) { if (seen.has(m.version)) fail(`Two migration files use version ${m.version}.`); seen.add(m.version); }
  return out.sort(cmp);
}

// local files vs remote history -> rows with status pending | applied | changed | remote_only
function plan(local, remote) {
  const r = new Map(remote.map((x) => [x.version, x])), l = new Map(local.map((x) => [x.version, x]));
  const rows = [], pending = [], mismatched = [];
  for (const m of local) {
    const have = r.get(m.version);
    if (!have) { pending.push(m); rows.push({ version: m.version, name: m.name, status: 'pending' }); }
    else if (have.checksum && have.checksum !== m.checksum) { mismatched.push(m); rows.push({ version: m.version, name: m.name, status: 'changed', applied_at: have.applied_at }); }
    else rows.push({ version: m.version, name: m.name, status: 'applied', applied_at: have.applied_at });
  }
  for (const x of remote) if (!l.has(x.version)) rows.push({ version: x.version, name: x.name, status: 'remote_only', applied_at: x.applied_at });
  rows.sort(cmp);
  return { rows, pending, mismatched };
}

function create(dir, name, sql = '') {
  const s = slug(name);
  if (!s) fail('Give the migration a name, for example: stitchdb migration new create_todos');
  let v = newVersion();
  const taken = new Set(readLocal(dir).map((m) => m.version));
  while (taken.has(v)) v = String(BigInt(v) + 1n);
  const file = path.join(dir, `${v}_${s}.sql`);
  writeFileSafe(file, sql);
  return { version: v, name: s, file };
}

module.exports = { normalize, checksum, readLocal, plan, create, slug, newVersion, FILE_RE };
