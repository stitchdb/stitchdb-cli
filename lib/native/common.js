// Shared pieces of the local services: JWTs (HS256, the local secret), request bodies, JSON answers and a small pool
// of database connections that runs a function as the request's role with its claims (so RLS applies as on StitchDB).
'use strict';
const crypto = require('crypto');
const pg = require('../pg');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload, secret) {
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
}
// The claims of a valid token, else null.
function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const want = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (head.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (claims.exp && claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch { return null; }
}
const bearer = (req) => (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1] || req.headers.apikey || null;

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError(413, 'The request is too large', 'payload_too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 8 * 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'The body is not valid JSON', 'invalid_json'); }
}
function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(data);
}

// Up to `size` connections to the local database as the superuser over its socket.
function pool({ sock, port, size = 6, name = 'stitchdb-local' }) {
  const idle = [], waiting = [];
  let open = 0;
  async function get() {
    while (idle.length) { const c = idle.pop(); if (!c.closed) return c; open--; }
    if (open < size) {
      open++;
      try { const c = await pg.connect({ socket: sock, port, user: 'postgres', database: 'postgres', application_name: name }); c.on('end', () => {}); return c; }
      catch (e) { open--; throw e; }
    }
    return new Promise((r) => waiting.push(r));
  }
  function put(c) {
    if (c.closed) { open--; const w = waiting.shift(); if (w) get().then(w); return; }
    const w = waiting.shift();
    if (w) w(c); else idle.push(c);
  }
  async function query(sql, params) { const c = await get(); try { return await c.query(sql, params); } finally { put(c); } }
  // fn(q) runs in a transaction as `role` (anon, authenticated or service_role) with the request's claims.
  async function asRole(claims, fn) {
    const role = ['anon', 'authenticated', 'service_role'].includes(claims?.role) ? claims.role : 'anon';
    const c = await get();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true), set_config('role', $3, true)`,
        [JSON.stringify(claims || { role }), claims?.sub || '', role]);
      const out = await fn((sql, params) => c.query(sql, params));
      await c.query('commit');
      return out;
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
    finally { put(c); }
  }
  async function end() { for (const c of idle.splice(0)) c.end(); }
  return { get, put, query, asRole, end };
}

module.exports = { sign, verify, bearer, HttpError, readBody, readJson, send, pool };
