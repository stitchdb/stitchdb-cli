// Schema diff between two pg_dump --schema-only outputs (sanitized): SQL that turns `from` into `to`.
// Objects are compared by pg_dump's "-- Name: X; Type: T; Schema: S;" headers. Tables are diffed column by column;
// functions and views are replaced; policies, indexes, triggers and constraints are dropped and re-created; objects
// only in `from` are dropped. Anything it cannot express safely is emitted as a commented note to review.
'use strict';

const HEAD = /^-- Name: (.+?); Type: (.+?); Schema: (.+?);/;
const qi = (s) => (/^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const qn = (schema, name) => (schema && schema !== '-' ? `${qi(schema)}.${name}` : name);

function parse(dump) {
  const objs = new Map();
  const order = [];
  let cur = null;
  for (const line of String(dump).split('\n')) {
    const m = HEAD.exec(line);
    if (m) {
      const [, name, type, schema] = m;
      const key = `${type}|${schema}|${name}`;
      cur = { key, name, type, schema, lines: [] };
      if (!objs.has(key)) order.push(key);
      objs.set(key, cur);
      continue;
    }
    if (!cur) continue;
    if (line === '--' || /^-- (PostgreSQL database dump|Dumped (from|by))/.test(line)) continue;
    cur.lines.push(line);
  }
  for (const o of objs.values()) o.body = o.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Platform-level privileges (who may use a schema, default privileges of the platform's roles) differ between the
  // local image and StitchDB and are not yours to migrate.
  for (const [k, o] of objs) if (o.type === 'DEFAULT ACL' || (o.type === 'ACL' && /^SCHEMA /.test(o.name))) { objs.delete(k); order.splice(order.indexOf(k), 1); }
  const extensions = new Map((String(dump).match(/^create extension if not exists .+$/gim) || []).map((l) => [/if not exists "?([^"\s]+)"?/i.exec(l)[1], l.trim()]));
  return { objs, order, extensions };
}

// "    title text DEFAULT 'x'::text NOT NULL," -> { name, def }
function columns(body) {
  const m = /CREATE (?:UNLOGGED )?TABLE [^\n]+ \(\n([\s\S]*?)\n\)/.exec(body);
  if (!m) return null;
  const cols = new Map();
  for (let l of m[1].split('\n')) {
    l = l.trim().replace(/,$/, '');
    if (!l || /^(CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE)\b/.test(l)) continue;
    const cm = /^("(?:[^"]|"")+"|[^\s]+)\s+(.*)$/.exec(l);
    if (cm) cols.set(cm[1], cm[2]);
  }
  return cols;
}
function splitDef(def) {
  let d = def, notNull = false, deflt = null, generated = null;
  const g = /\s+GENERATED ALWAYS AS \((.*)\) STORED/.exec(d); if (g) { generated = g[1]; d = d.replace(g[0], ''); }
  if (/\s+NOT NULL$/.test(d)) { notNull = true; d = d.replace(/\s+NOT NULL$/, ''); }
  const dm = /\s+DEFAULT (.*)$/.exec(d); if (dm) { deflt = dm[1]; d = d.slice(0, dm.index); }
  return { type: d.trim(), notNull, deflt, generated };
}

function dropSql(o) {
  const n = o.name;
  switch (o.type) {
    case 'TABLE': return `drop table if exists ${qn(o.schema, qi(n))} cascade;`;
    case 'VIEW': return `drop view if exists ${qn(o.schema, qi(n))} cascade;`;
    case 'MATERIALIZED VIEW': return `drop materialized view if exists ${qn(o.schema, qi(n))} cascade;`;
    case 'FUNCTION': case 'PROCEDURE': { const fm = /^(.+?)\((.*)\)$/.exec(n); return fm ? `drop ${o.type.toLowerCase()} if exists ${qn(o.schema, qi(fm[1]))}(${fm[2]});` : null; }
    case 'SEQUENCE': return `drop sequence if exists ${qn(o.schema, qi(n))};`;
    case 'TYPE': return `drop type if exists ${qn(o.schema, qi(n))};`;
    case 'INDEX': return `drop index if exists ${qn(o.schema, qi(n))};`;
    case 'POLICY': { const [t, ...p] = n.split(' '); return `drop policy if exists ${qi(p.join(' '))} on ${qn(o.schema, qi(t))};`; }
    case 'TRIGGER': { const [t, ...tr] = n.split(' '); return `drop trigger if exists ${qi(tr.join(' '))} on ${qn(o.schema, qi(t))};`; }
    case 'CONSTRAINT': case 'FK CONSTRAINT': { const [t, ...cn] = n.split(' '); return `alter table ${qn(o.schema, qi(t))} drop constraint if exists ${qi(cn.join(' '))};`; }
    case 'DEFAULT': { const [t, col] = n.split(' '); return `alter table ${qn(o.schema, qi(t))} alter column ${qi(col)} drop default;`; }
    case 'ROW SECURITY': return `alter table ${qn(o.schema, qi(n))} disable row level security;`;
    case 'SCHEMA': return `-- schema ${n} exists only in the migrations: drop it by hand if that is intended (drop schema ${qi(n)} cascade;)`;
    case 'ACL': case 'COMMENT': case 'SEQUENCE OWNED BY': case 'EXTENSION': return null;
    default: return `-- ${o.type.toLowerCase()} ${n} exists only in the migrations: review`;
  }
}
const orReplace = (body, type) => body.replace(new RegExp(`^CREATE ${type} `, 'm'), `CREATE OR REPLACE ${type} `);

function tableAlter(a, b) {
  const ca = columns(a.body), cb = columns(b.body);
  if (!ca || !cb) return [`-- table ${a.name} changed: review\n${b.body}`];
  const t = qn(b.schema, qi(b.name)), out = [];
  for (const [col, def] of cb) if (!ca.has(col)) out.push(`alter table ${t} add column ${col} ${def};`);
  for (const col of ca.keys()) if (!cb.has(col)) out.push(`alter table ${t} drop column ${col};`);
  for (const [col, defB] of cb) {
    const defA = ca.get(col);
    if (defA === undefined || defA === defB) continue;
    const x = splitDef(defA), y = splitDef(defB);
    if (x.generated !== y.generated) { out.push(`alter table ${t} drop column ${col};`, `alter table ${t} add column ${col} ${defB};`); continue; }
    if (x.type !== y.type) out.push(`alter table ${t} alter column ${col} type ${y.type} using ${col}::${y.type};`);
    if (x.deflt !== y.deflt) out.push(y.deflt == null ? `alter table ${t} alter column ${col} drop default;` : `alter table ${t} alter column ${col} set default ${y.deflt};`);
    if (x.notNull !== y.notNull) out.push(`alter table ${t} alter column ${col} ${y.notNull ? 'set' : 'drop'} not null;`);
  }
  return out;
}

function diff(fromDump, toDump) {
  const A = parse(fromDump), B = parse(toDump);
  const drops = [], alters = [], creates = [];
  // Only in `from` (reverse order so dependents go first).
  for (const key of [...A.order].reverse()) {
    if (B.objs.has(key)) continue;
    const s = dropSql(A.objs.get(key)); if (s) drops.push(s);
  }
  for (const key of B.order) {
    const b = B.objs.get(key), a = A.objs.get(key);
    if (!a) { if (b.body) creates.push(b.body); continue; }
    if (a.body === b.body || !b.body) continue;
    switch (b.type) {
      case 'TABLE': alters.push(...tableAlter(a, b)); break;
      case 'FUNCTION': case 'PROCEDURE': alters.push(orReplace(b.body, b.type)); break;
      case 'VIEW': alters.push(`${dropSql(a)}\n${b.body}`); break;
      case 'POLICY': case 'INDEX': case 'TRIGGER': case 'CONSTRAINT': case 'FK CONSTRAINT': case 'MATERIALIZED VIEW': case 'TYPE':
        alters.push(`${dropSql(a)}\n${b.body}`); break;
      case 'DEFAULT': case 'ROW SECURITY': case 'ACL': case 'COMMENT': case 'SEQUENCE OWNED BY': alters.push(b.body); break;
      default: alters.push(`-- ${b.type.toLowerCase()} ${b.name} changed: review\n${b.body}`);
    }
  }
  const ext = [...B.extensions].filter(([name]) => !A.extensions.has(name)).map(([, line]) => line);
  const parts = [...ext, ...drops, ...alters, ...creates].filter(Boolean);
  // Drop pg_dump session preamble lines that sneak into object bodies.
  return parts.map((p) => p.split('\n').filter((l) => !/^SET |^SELECT pg_catalog\.set_config/.test(l)).join('\n')).join('\n\n').trim();
}

module.exports = { diff, parse, columns, splitDef };
