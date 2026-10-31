// Local Realtime service (/realtime/v1): the same socket protocol as StitchDB Realtime (protocol 1.0.0 and 2.0.0) for
// Broadcast, Presence and Postgres changes, plus the broadcast REST endpoint.
//   Postgres changes: tables in the stitchdb_realtime publication get a row trigger (see templates/local/init.sql) that
//   queues the change and NOTIFYs; each subscriber gets a change only when its role may read that row (RLS, checked by
//   primary key as the subscriber), deletes carry the primary key (all old values with REPLICA IDENTITY FULL).
//   Private channels: your policies on realtime.messages decide who may join (read) and send (write), with
//   realtime.topic() set to the channel's topic, as on StitchDB.
'use strict';
const crypto = require('crypto');
const ws = require('./ws');
const { verify, bearer, HttpError, readBody, send } = require('./common');
const pg = require('../pg');

function createRealtime({ db, secret, connectListener }) {
  const topics = new Map(); // topic -> Set(channel)
  const presence = new Map(); // topic -> Map(key -> [{meta, channel}])
  const relCache = new Map();

  // ---------- encoding ----------
  const encode = (sock, joinRef, ref, topic, event, payload) => (sock.vsn === '2.0.0' ? JSON.stringify([joinRef, ref, topic, event, payload]) : JSON.stringify({ join_ref: joinRef, ref, topic, event, payload }));
  const push = (ch, event, payload, ref = null) => ch.sock.ws.send(encode(ch.sock, ch.joinRef, ref, ch.topic, event, payload));
  const reply = (sock, m, status, response = {}) => sock.ws.send(encode(sock, m.join_ref, m.ref, m.topic, 'phx_reply', { status, response }));
  function decode(sock, data, binary) {
    if (binary) {
      const b = Buffer.from(data);
      if (b[0] !== 3) return null; // userBroadcastPush
      const [jl, rl, tl, el, ml, enc] = [b[1], b[2], b[3], b[4], b[5], b[6]];
      let o = 7;
      const take = (n) => { const s = b.toString('utf8', o, o + n); o += n; return s; };
      const join_ref = take(jl) || null, ref = take(rl) || null, topic = take(tl), ev = take(el), meta = take(ml);
      const raw = b.subarray(o);
      const payload = { type: 'broadcast', event: ev, payload: enc === 1 ? JSON.parse(raw.toString('utf8') || '{}') : raw.toString('base64'), ...(meta ? JSON.parse(meta) : {}) };
      return { join_ref, ref, topic, event: 'broadcast', payload };
    }
    const j = JSON.parse(String(data));
    if (Array.isArray(j)) { const [join_ref, ref, topic, event, payload] = j; return { join_ref, ref, topic, event, payload }; }
    return j;
  }

  // ---------- permissions ----------
  const claimsFor = (token) => verify(token, secret);
  const sub = (topic) => topic.replace(/^realtime:/, '');
  // Private channels: may the role read / write messages on this topic? (a probe row, rolled back)
  async function privateAccess(claims, topic) {
    if (claims.role === 'service_role') return { read: true, write: true };
    const c = await db.get();
    const role = ['anon', 'authenticated'].includes(claims.role) ? claims.role : 'anon';
    const as = async () => c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('realtime.topic', $3, true), set_config('role', $4, true)`, [JSON.stringify(claims), claims.sub || '', topic, role]);
    try {
      await c.query('begin');
      const id = (await c.query(`insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true) returning id`, [topic])).rows[0].id;
      await as();
      const read = !!(await c.query('select 1 from realtime.messages where id = $1', [id]).catch(() => ({ rows: [] }))).rows[0];
      await c.query('rollback');
      await c.query('begin');
      await as();
      const write = await c.query(`insert into realtime.messages (topic, extension, private, event) values ($1, 'broadcast', true, 'probe')`, [topic]).then(() => true, () => false);
      await c.query('rollback');
      return { read, write };
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
    finally { db.put(c); }
  }

  // ---------- channels ----------
  function fanout(topic, event, payload, { except, privateOnly } = {}) {
    for (const ch of topics.get(topic) || []) {
      if (ch === except) continue;
      if (privateOnly !== undefined && ch.private !== privateOnly) continue;
      if (ch.private && !ch.access?.read) continue;
      push(ch, event, payload);
    }
  }
  function leavePresence(ch) {
    const map = presence.get(ch.topic);
    if (!map || !ch.presenceKey) return;
    const list = map.get(ch.presenceKey) || [];
    const mine = list.filter((x) => x.channel === ch);
    if (!mine.length) return;
    const rest = list.filter((x) => x.channel !== ch);
    if (rest.length) map.set(ch.presenceKey, rest); else map.delete(ch.presenceKey);
    fanout(ch.topic, 'presence_diff', { joins: {}, leaves: { [ch.presenceKey]: { metas: mine.map((x) => x.meta) } } });
  }
  function leave(ch) {
    leavePresence(ch);
    const set = topics.get(ch.topic);
    if (set) { set.delete(ch); if (!set.size) topics.delete(ch.topic); }
    ch.sock.channels.delete(ch.topic);
  }

  async function join(sock, m) {
    const cfg = m.payload?.config || {};
    const token = m.payload?.access_token || sock.token;
    const claims = claimsFor(token);
    if (!claims) return reply(sock, m, 'error', { reason: 'Invalid JWT (signature or expiry)' });
    const old = sock.channels.get(m.topic);
    if (old) leave(old);
    const ch = { sock, topic: m.topic, joinRef: m.join_ref ?? m.ref, claims, private: !!cfg.private, self: !!cfg.broadcast?.self, ack: !!cfg.broadcast?.ack,
      presenceKey: cfg.presence?.key || crypto.randomUUID(), presenceEnabled: cfg.presence?.enabled !== false, pg: [] };
    if (ch.private) {
      try { ch.access = await privateAccess(claims, sub(m.topic)); } catch (e) { return reply(sock, m, 'error', { reason: e.message }); }
      if (!ch.access.read) return reply(sock, m, 'error', { reason: 'You do not have permission to join this channel (realtime.messages policies)' });
    }
    const bindings = Array.isArray(cfg.postgres_changes) ? cfg.postgres_changes : [];
    ch.pg = bindings.map((b) => ({ id: Math.floor(Math.random() * 2 ** 31), event: b.event || '*', schema: b.schema || 'public', table: b.table, filter: b.filter, select: b.select }));
    sock.channels.set(m.topic, ch);
    if (!topics.has(m.topic)) topics.set(m.topic, new Set());
    topics.get(m.topic).add(ch);
    reply(sock, m, 'ok', { postgres_changes: ch.pg.map((b) => ({ id: b.id, event: b.event, schema: b.schema, table: b.table, ...(b.filter ? { filter: b.filter } : {}) })) });
    // Every channel listens: database broadcasts (realtime.send, broadcast triggers) reach broadcast-only channels too.
    listen().catch(() => {});
    if (ch.presenceEnabled) {
      const state = {};
      for (const [k, list] of presence.get(m.topic) || []) state[k] = { metas: list.map((x) => x.meta) };
      push(ch, 'presence_state', state);
    }
    if (ch.pg.length) {
      push(ch, 'system', { message: 'Subscribed to PostgreSQL', status: 'ok', extension: 'postgres_changes', channel: sub(m.topic) });
    }
  }

  function onMessage(sock, data, binary) {
    let m;
    try { m = decode(sock, data, binary); } catch { return; }
    if (!m || !m.topic) return;
    if (m.topic === 'phoenix' && m.event === 'heartbeat') return reply(sock, m, 'ok');
    if (m.event === 'phx_join') return join(sock, m).catch((e) => reply(sock, m, 'error', { reason: e.message }));
    const ch = sock.channels.get(m.topic);
    if (!ch) return reply(sock, m, 'error', { reason: 'Unknown channel (join it first)' });
    switch (m.event) {
      case 'broadcast': {
        if (ch.private && !ch.access?.write) return reply(sock, m, 'error', { reason: 'You do not have permission to send on this channel' });
        const p = m.payload || {};
        fanout(ch.topic, 'broadcast', { type: 'broadcast', event: p.event, payload: p.payload }, { except: ch.self ? undefined : ch });
        return reply(sock, m, 'ok');
      }
      case 'presence': {
        const p = m.payload || {};
        if (ch.private && !ch.access?.write) return reply(sock, m, 'error', { reason: 'You do not have permission to track presence on this channel' });
        if (p.event === 'track') {
          leavePresence(ch);
          const meta = { phx_ref: crypto.randomBytes(8).toString('base64url'), ...(p.payload || {}) };
          if (!presence.has(ch.topic)) presence.set(ch.topic, new Map());
          const map = presence.get(ch.topic);
          map.set(ch.presenceKey, [...(map.get(ch.presenceKey) || []), { meta, channel: ch }]);
          fanout(ch.topic, 'presence_diff', { joins: { [ch.presenceKey]: { metas: [meta] } }, leaves: {} });
        } else if (p.event === 'untrack') leavePresence(ch);
        return reply(sock, m, 'ok');
      }
      case 'access_token': {
        const c = claimsFor(m.payload?.access_token);
        if (c) ch.claims = c;
        return reply(sock, m, 'ok');
      }
      case 'phx_leave':
        leave(ch);
        reply(sock, m, 'ok');
        return sock.ws.send(encode(sock, ch.joinRef, m.ref, m.topic, 'phx_close', {}));
      default:
        return reply(sock, m, 'ok');
    }
  }

  // ---------- postgres changes ----------
  // The queue only fills up for subscribers: what was queued while nobody listened (no channel joined yet, or all left)
  // is dropped when listening starts, as on StitchDB, where a new subscriber never gets changes from before it joined.
  // A reconnect while channels stay joined keeps the queue, so they miss nothing. Without any listener, a prune keeps
  // the queue from growing (writes to published tables with no subscriber at all).
  let listener = null, draining = false, again = false, fresh = true;
  const STALE = "delete from realtime._local_events where at < now() - interval '1 minute'";
  const prune = setInterval(() => { if (!listener) db.query(STALE).catch(() => {}); }, 60000);
  prune.unref?.();
  async function listen() {
    if (listener) return listener;
    listener = (async () => {
      const c = await connectListener();
      c.on('notification', () => drain());
      c.on('end', () => { listener = null; fresh = !topics.size; if (topics.size) setTimeout(() => listen().catch(() => {}), 1000); });
      await c.query('listen stitchdb_realtime');
      if (fresh) await c.query('delete from realtime._local_events where at < now()');
      fresh = false;
      drain();
      return c;
    })().catch((e) => { listener = null; throw e; });
    return listener;
  }
  async function drain() {
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        const r = await db.query('delete from realtime._local_events where id in (select id from realtime._local_events order by id limit 500) returning id, kind, body');
        const rows = r.rows.sort((a, b) => Number(a.id) - Number(b.id));
        for (const e of rows) await deliver(e).catch((err) => process.stderr.write(`realtime: ${err.message}\n`));
        if (rows.length === 500) again = true;
      } while (again);
    } finally { draining = false; }
  }
  async function relInfo(relid) {
    const hit = relCache.get(relid);
    if (hit && Date.now() - hit.at < 5000) return hit;
    const r = await db.query(`select c.relrowsecurity as rls, c.relreplident as ident,
        coalesce((select json_agg(json_build_object('name', a.attname, 'type', t.typname) order by a.attnum) from pg_attribute a join pg_type t on t.oid = a.atttypid
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]') as columns,
        coalesce((select json_agg(a.attname order by k.n) from pg_index i, unnest(i.indkey) with ordinality k(attnum, n), pg_attribute a
          where i.indrelid = c.oid and i.indisprimary and a.attrelid = c.oid and a.attnum = k.attnum), '[]') as pk
      from pg_class c where c.oid = $1`, [relid]);
    const info = { ...(r.rows[0] || { rls: false, ident: 'd', columns: [], pk: [] }), at: Date.now() };
    relCache.set(relid, info);
    return info;
  }
  const OPS = { eq: (a, b) => String(a) === b, neq: (a, b) => String(a) !== b, lt: (a, b) => cmp(a, b) < 0, lte: (a, b) => cmp(a, b) <= 0, gt: (a, b) => cmp(a, b) > 0, gte: (a, b) => cmp(a, b) >= 0,
    in: (a, b) => b.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).includes(String(a)) };
  const cmp = (a, b) => { const x = Number(a), y = Number(b); return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a).localeCompare(b); };
  function matches(filter, rec) {
    if (!filter) return true;
    const m = /^([^=]+)=(eq|neq|lt|lte|gt|gte|in)\.(.*)$/.exec(filter);
    if (!m || !rec) return false;
    const v = rec[m[1]];
    if (v === undefined || v === null) return false;
    return OPS[m[2]](typeof v === 'object' ? JSON.stringify(v) : v, m[3]);
  }
  async function canSee(claims, schema, table, info, rec) {
    const role = ['anon', 'authenticated', 'service_role'].includes(claims.role) ? claims.role : 'anon';
    if (role === 'service_role') return true;
    const rel = `${pg.ident(schema)}.${pg.ident(table)}`;
    if (!info.rls) return (await db.query(`select has_table_privilege($1, $2, 'SELECT') ok`, [role, rel])).rows[0].ok;
    if (!info.pk.length || !rec) return false;
    return db.asRole(claims, (q) => q(`select 1 from ${rel} where ${info.pk.map((k, i) => `${pg.ident(k)}::text = $${i + 1}`).join(' and ')}`,
      info.pk.map((k) => (rec[k] !== null && typeof rec[k] === 'object' ? JSON.stringify(rec[k]) : String(rec[k]))))).then((r) => !!r.rows[0], () => false);
  }
  const pick = (rec, cols) => (rec && Array.isArray(cols) && cols.length ? Object.fromEntries(Object.entries(rec).filter(([k]) => cols.includes(k))) : rec);

  async function deliver(e) {
    const b = e.body;
    if (e.kind === 'broadcast') return fanout(`realtime:${b.topic}`, 'broadcast', { type: 'broadcast', event: b.event, payload: b.payload }, { privateOnly: !!b.private });
    if (e.kind !== 'change') return;
    const info = await relInfo(b.relid);
    let old = b.old_record;
    if (old && info.ident !== 'f') old = Object.fromEntries(info.pk.map((k) => [k, old[k]]));
    const columns = info.columns;
    for (const set of topics.values()) {
      for (const ch of set) {
        const ids = ch.pg.filter((x) => (x.schema === '*' || x.schema === b.schema) && (!x.table || x.table === '*' || x.table === b.table)
          && (x.event === '*' || x.event.toUpperCase() === b.type) && matches(x.filter, b.type === 'DELETE' ? b.old_record : b.record));
        if (!ids.length) continue;
        if (ch.private && !ch.access?.read) continue;
        if (!(await canSee(ch.claims, b.schema, b.table, info, b.type === 'DELETE' ? null : b.record).catch(() => false)) && !(b.type === 'DELETE' && await canSee({ role: ch.claims.role }, b.schema, b.table, { ...info, rls: false }, null).catch(() => false))) continue;
        const sel = ids[0].select;
        push(ch, 'postgres_changes', { ids: ids.map((x) => x.id), data: { schema: b.schema, table: b.table, commit_timestamp: b.commit_timestamp, type: b.type,
          columns: sel ? columns.filter((x) => sel.includes(x.name)) : columns, record: b.type === 'DELETE' ? {} : pick(b.record, sel), old_record: b.type === 'INSERT' ? {} : pick(old, sel), errors: null } });
      }
    }
  }

  // ---------- HTTP ----------
  async function broadcastHttp(req, res, sub) {
    const claims = verify(bearer(req), secret);
    if (!claims) return send(res, 401, { message: 'Invalid JWT (signature or expiry)' });
    const url = new URL(sub, 'http://local');
    let messages;
    const one = /^\/api\/broadcast\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const body = await readBody(req, 4 * 1024 * 1024);
      let payload; try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { payload = body.toString('base64'); }
      messages = [{ topic: decodeURIComponent(one[1]), event: decodeURIComponent(one[2]), payload, private: url.searchParams.get('private') === 'true' }];
    } else {
      let j; try { j = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}'); } catch { return send(res, 400, { message: 'The body is not valid JSON' }); }
      messages = Array.isArray(j.messages) ? j.messages : [];
    }
    for (const msg of messages) {
      if (msg.private) { const a = await privateAccess(claims, msg.topic); if (!a.write) continue; }
      fanout(`realtime:${msg.topic}`, 'broadcast', { type: 'broadcast', event: msg.event, payload: msg.payload }, { privateOnly: !!msg.private });
    }
    res.writeHead(202, { 'content-type': 'application/json' }); res.end('{}');
  }

  return {
    // /realtime/v1/websocket (and /socket/websocket)
    upgrade(req, socket, head) {
      const url = new URL(req.url, 'http://local');
      const token = url.searchParams.get('apikey') || bearer(req);
      if (!verify(token, secret)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      const w = ws.accept(req, socket, head);
      if (!w) return;
      const sock = { ws: w, vsn: url.searchParams.get('vsn') || '1.0.0', token, channels: new Map() };
      w.on('message', (d, bin) => onMessage(sock, d, bin));
      w.on('close', () => { for (const ch of [...sock.channels.values()]) leave(ch); });
    },
    async handle(req, res, sub) {
      try {
        if (req.method === 'POST' && sub.startsWith('/api/broadcast')) return await broadcastHttp(req, res, sub);
        if (sub.startsWith('/api/health') || sub === '/' || sub.startsWith('/api/ping')) return send(res, 200, { status: 'ok', local: true });
        send(res, 404, { message: 'Not found' });
      } catch (e) { send(res, e.status || 500, { message: e.message }); }
    },
    stats: () => ({ channels: [...topics.values()].reduce((n, s) => n + s.size, 0) }),
    async close() { clearInterval(prune); const l = await listener?.catch(() => null); l?.end(); },
  };
}

module.exports = { createRealtime, HttpError };
