// A small Postgres client (wire protocol v3) for the local runtime: no dependencies. Connects over TCP or a Unix socket,
// authenticates with trust, password, md5 or SCRAM-SHA-256, runs simple queries (several statements) and parameterized
// queries (extended protocol, text format), and delivers LISTEN notifications. One query at a time per connection
// (calls queue up). Values come back as text except: bool, integers that fit, floats, json/jsonb (parsed).
'use strict';
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OID = { bool: 16, int8: 20, int2: 21, int4: 23, oid: 26, json: 114, float4: 700, float8: 701, numeric: 1700, jsonb: 3802 };
function parseValue(type, v) {
  if (v === null) return null;
  switch (type) {
    case OID.bool: return v === 't';
    case OID.int2: case OID.int4: case OID.oid: case OID.float4: case OID.float8: return Number(v);
    case OID.int8: { const n = Number(v); return Number.isSafeInteger(n) ? n : v; }
    case OID.json: case OID.jsonb: try { return JSON.parse(v); } catch { return v; }
    default: return v;
  }
}

class PgError extends Error {
  constructor(f) { super(f.M || 'database error'); Object.assign(this, { code: f.C, detail: f.D, hint: f.H, position: f.P, severity: f.S, schema: f.s, table: f.t, column: f.c, constraint: f.n }); }
}

// Wire helpers
const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
function msg(type, ...parts) {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : cstr(p))));
  const head = Buffer.alloc(type ? 5 : 4);
  if (type) { head.write(type, 0); head.writeInt32BE(body.length + 4, 1); } else head.writeInt32BE(body.length + 4, 0);
  return Buffer.concat([head, body]);
}
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

class Client extends EventEmitter {
  // opts: { host, port, socket (dir or full path of the Unix socket), user, password, database, application_name }
  constructor(opts) { super(); this.opts = opts; this.buf = Buffer.alloc(0); this.queue = []; this.cur = null; this.closed = false; this.params = {}; }

  connect() {
    const o = this.opts;
    return new Promise((resolve, reject) => {
      const path = o.socket ? (o.socket.endsWith(`.s.PGSQL.${o.port || 5432}`) ? o.socket : `${o.socket}/.s.PGSQL.${o.port || 5432}`) : null;
      const s = path ? net.connect(path) : net.connect(o.port || 5432, o.host || '127.0.0.1');
      this.sock = s;
      s.setNoDelay(true);
      this._ready = { resolve, reject };
      s.on('connect', () => {
        const kv = { user: o.user || 'postgres', database: o.database || 'postgres', client_encoding: 'UTF8', application_name: o.application_name || 'stitchdb-cli' };
        s.write(msg(null, i32(196608), ...Object.entries(kv).flatMap(([k, v]) => [k, v]), Buffer.from([0])));
      });
      s.on('data', (d) => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this._drain(); });
      s.on('error', (e) => this._fatal(e));
      s.on('close', () => this._fatal(new Error('Connection to the database closed')));
    });
  }

  _fatal(e) {
    if (this.closed) return;
    this.closed = true;
    if (this._ready) { this._ready.reject(e); this._ready = null; }
    if (this.cur) this.cur.reject(e);
    for (const q of this.queue) q.reject(e);
    this.cur = null; this.queue = [];
    this.emit('end', e);
  }

  _drain() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try { this._handle(type, body); } catch (e) { this._fatal(e); return; }
    }
  }

  _fields(body) {
    const f = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) { const code = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); f[code] = body.toString('utf8', i + 1, end); i = end + 1; }
    return f;
  }

  _handle(type, body) {
    const q = this.cur;
    switch (type) {
      case 'R': return this._auth(body);
      case 'S': { const a = body.indexOf(0); this.params[body.toString('utf8', 0, a)] = body.toString('utf8', a + 1, body.indexOf(0, a + 1)); return; }
      case 'K': return;
      case 'Z':
        if (this._ready) { const r = this._ready; this._ready = null; r.resolve(this); return; }
        if (q) { this.cur = null; if (q.error) q.reject(q.error); else q.resolve(q.multi ? q.results : q.results[q.results.length - 1] || { rows: [], fields: [], command: '', rowCount: 0 }); this._next(); }
        return;
      case 'T': {
        const n = body.readInt16BE(0); let i = 2; const fields = [];
        for (let k = 0; k < n; k++) { const end = body.indexOf(0, i); const name = body.toString('utf8', i, end); i = end + 1; const tableOid = body.readInt32BE(i); const typ = body.readInt32BE(i + 6); fields.push({ name, type: typ, tableOid }); i += 18; }
        if (q) q.res = { rows: [], fields, command: '', rowCount: 0 };
        return;
      }
      case 'D': {
        if (!q) return;
        q.res ||= { rows: [], fields: [], command: '', rowCount: 0 };
        const n = body.readInt16BE(0); let i = 2; const row = {}; const f = q.res.fields;
        for (let k = 0; k < n; k++) {
          const l = body.readInt32BE(i); i += 4;
          const v = l < 0 ? null : body.toString('utf8', i, i + l); if (l > 0) i += l;
          row[f[k]?.name ?? k] = q.raw ? v : parseValue(f[k]?.type, v);
        }
        q.res.rows.push(row);
        return;
      }
      case 'C': {
        if (!q) return;
        const tag = body.toString('utf8', 0, body.length - 1);
        const r = q.res || { rows: [], fields: [], command: '', rowCount: 0 };
        r.command = tag.split(' ')[0]; const last = Number(tag.split(' ').pop()); r.rowCount = Number.isFinite(last) ? last : r.rows.length;
        q.results.push(r); q.res = null;
        return;
      }
      case 'I': if (q) { q.results.push({ rows: [], fields: [], command: '', rowCount: 0 }); } return;
      case 'E': { const e = new PgError(this._fields(body)); if (this._ready) { const r = this._ready; this._ready = null; r.reject(e); this.sock.destroy(); return; } if (q) q.error ||= e; return; }
      case 'N': this.emit('notice', this._fields(body)); return;
      case 'A': { const pid = body.readInt32BE(0); const a = body.indexOf(0, 4); this.emit('notification', { pid, channel: body.toString('utf8', 4, a), payload: body.toString('utf8', a + 1, body.indexOf(0, a + 1)) }); return; }
      case '1': case '2': case '3': case 'n': case 't': return;
      default: return;
    }
  }

  _auth(body) {
    const kind = body.readInt32BE(0);
    const o = this.opts;
    if (kind === 0) return;
    if (kind === 3) return this.sock.write(msg('p', o.password || ''));
    if (kind === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(String(o.password || '') + (o.user || 'postgres')).digest('hex');
      return this.sock.write(msg('p', 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex')));
    }
    if (kind === 10) {
      this.scram = { nonce: crypto.randomBytes(18).toString('base64') };
      this.scram.first = `n=*,r=${this.scram.nonce}`;
      const data = Buffer.from('n,,' + this.scram.first);
      return this.sock.write(msg('p', 'SCRAM-SHA-256', i32(data.length), data));
    }
    if (kind === 11) {
      const server = body.toString('utf8', 4);
      const a = Object.fromEntries(server.split(',').map((x) => [x[0], x.slice(2)]));
      if (!a.r.startsWith(this.scram.nonce)) throw new Error('SCRAM: bad server nonce');
      const salted = crypto.pbkdf2Sync(String(o.password || '').normalize('NFKC'), Buffer.from(a.s, 'base64'), Number(a.i), 32, 'sha256');
      const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
      const clientKey = hmac(salted, 'Client Key');
      const stored = crypto.createHash('sha256').update(clientKey).digest();
      const without = `c=biws,r=${a.r}`;
      const authMsg = `${this.scram.first},${server},${without}`;
      const sig = hmac(stored, authMsg);
      const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i])).toString('base64');
      this.scram.serverSig = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
      return this.sock.write(msg('p', Buffer.from(`${without},p=${proof}`)));
    }
    if (kind === 12) {
      const v = body.toString('utf8', 4).replace(/^v=/, '');
      if (v !== this.scram.serverSig) throw new Error('SCRAM: the server signature does not match');
      return;
    }
    throw new Error(`Unsupported authentication method (${kind})`);
  }

  _next() {
    if (this.cur || !this.queue.length || this.closed) return;
    this.cur = this.queue.shift();
    this.sock.write(this.cur.wire);
  }

  // query(sql) → last result {rows, fields, command, rowCount}; query(sql, params) uses the extended protocol (one
  // statement, $1..$n as text). opts.multi: every result of a multi-statement simple query; opts.raw: text values.
  query(sql, params, opts = {}) {
    if (this.closed) return Promise.reject(new Error('Connection to the database closed'));
    let wire;
    if (params && params.length) {
      const vals = params.map((v) => (v === null || v === undefined ? null : Buffer.from(typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v), 'utf8')));
      const bind = [cstr(''), cstr(''), i16(0), i16(vals.length), ...vals.flatMap((b) => (b === null ? [i32(-1)] : [i32(b.length), b])), i16(0)];
      wire = Buffer.concat([msg('P', '', sql, i16(0)), msg('B', ...bind), msg('D', Buffer.from('P'), cstr('')), msg('E', '', i32(0)), msg('S')]);
    } else wire = msg('Q', sql);
    return new Promise((resolve, reject) => { this.queue.push({ wire, resolve, reject, results: [], multi: !!opts.multi, raw: !!opts.raw }); this._next(); });
  }

  end() {
    if (this.closed) return;
    try { this.sock.write(msg('X')); } catch {}
    this.closed = true;
    this.sock.end();
  }
}

async function connect(opts) { const c = new Client(opts); await c.connect(); return c; }

// Escaping for the few places that build SQL text (identifiers and literals).
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const literal = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

module.exports = { Client, connect, PgError, ident, literal, OID };
