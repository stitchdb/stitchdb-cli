// Building blocks for the dashboard-feature commands (lib/commands/features.js, app-settings.js): one Management API
// call per command (/platform/v1/projects/:ref/...), request bodies from --file / key=value pairs, and a readable
// default rendering of any answer (tables for lists, aligned fields for objects; --json prints everything).
'use strict';
const U = require('./util');
const api = require('./api');
const M = require('./manage');

// The project: a ref as the first positional argument only when more positionals are given than the command needs
// (so a 16-letter queue or flag name is never taken for a ref), else --project-ref / the linked project.
function refOf(flags, args, need = 0, { allowBranch = true } = {}) {
  if (args.length > need && M.REF_RE.test(args[0])) return args.shift();
  return M.projectRef(flags, [], { allowBranch, positional: false });
}

function call(method, path, { body, query } = {}) {
  if (method === 'GET') return api.get(path, { query });
  if (method === 'DELETE') return api.del(path, { query });
  if (method === 'POST') return api.post(path, body ?? {}, { query });
  if (method === 'PATCH') return api.patch(path, body ?? {}, { query });
  return api.request(method, path, { body: body ?? {}, query });
}

// "a.b.c=value" -> { a: { b: { c: value } } } merged into obj.
function setPath(obj, key, val) {
  const parts = key.split('.');
  if (parts.some((p) => !p || p === '__proto__' || p === 'constructor' || p === 'prototype')) U.fail(`"${key}" is not a field name.`);
  let o = obj;
  for (const p of parts.slice(0, -1)) { if (typeof o[p] !== 'object' || o[p] === null || Array.isArray(o[p])) o[p] = {}; o = o[p]; }
  o[parts.at(-1)] = val;
  return obj;
}
const KV_RE = /^[A-Za-z_][\w.]*=/;
// The request body: --file <json> (an object), then key=value positionals and --set key=value (dots reach nested fields).
// key=value positionals are taken out of args. array: a JSON file may also hold a list (wrapped as { [array]: list }).
function input(flags, args = [], { array } = {}) {
  let b = {};
  if (flags.file) {
    const j = M.readJson(flags.file);
    if (Array.isArray(j) && array) b = { [array]: j };
    else if (!j || typeof j !== 'object' || Array.isArray(j)) U.fail(`${flags.file} must hold a JSON object.`);
    else b = j;
  }
  const kv = [];
  for (let i = args.length - 1; i >= 0; i--) if (KV_RE.test(args[i])) kv.unshift(...args.splice(i, 1));
  for (const item of [...kv, ...[].concat(flags.set || [])]) {
    const i = String(item).indexOf('=');
    if (i <= 0) U.fail(`"${item}" is not key=value.`);
    setPath(b, item.slice(0, i).trim(), M.value(item.slice(i + 1).trim()));
  }
  return b;
}
const needBody = (b, hint) => { if (!Object.keys(b).length) U.fail('Nothing to send.', { hint: hint || 'Pass --file <json> or key=value pairs.' }); return b; };

const need = (v, msg) => { if (v === undefined || v === null || v === '') U.fail(msg); return String(v); };
const intArg = (v, what) => { if (!/^\d+$/.test(String(v ?? ''))) U.fail(`Give the ${what} (a number).`); return Number(v); };
const matchArg = (v, re, what) => { if (!re.test(String(v ?? ''))) U.fail(`Give the ${what}.`); return String(v); };
const enc = encodeURIComponent;
function isoTime(v, what = 'time') {
  const s = need(v, `Give the ${what} (ISO 8601, like 2026-11-01T14:30:00Z).`);
  if (Number.isNaN(Date.parse(s))) U.fail(`${what} is not a date and time: "${s}" (use ISO 8601, like 2026-11-01T14:30:00Z).`);
  return new Date(s).toISOString();
}
// "schema.table" | "table" -> { schema, table }.
function tableArg(v, { schema = 'public' } = {}) {
  const s = need(v, 'Give the table (schema.table or table).');
  const i = s.indexOf('.');
  return i > 0 ? { schema: s.slice(0, i), table: s.slice(i + 1) } : { schema, table: s };
}

// ---------- default rendering ----------
const scalar = (v) => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;
function cell(v, width = 60) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : '';
  if (typeof v === 'string' && ISO_RE.test(v)) return M.date(v);
  if (Array.isArray(v)) return v.every(scalar) ? v.join(', ') : `${v.length} item(s)`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, width);
  const s = String(v).replace(/\s+/g, ' ');
  return s.length > width ? s.slice(0, width - 1) + '…' : s;
}
const label = (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
function rows(list, cols) {
  if (!list.length) return U.table(['-'], []);
  cols = cols || Object.keys(list[0]).filter((k) => list.some((x) => scalar(x[k]) || (Array.isArray(x[k]) && x[k].every(scalar)))).slice(0, 8);
  U.table(cols.map((c) => c.toUpperCase()), list.map((x) => cols.map((c) => cell(x[c], 50))));
}
function show(r) {
  if (Array.isArray(r)) return rows(r);
  if (!r || typeof r !== 'object') return r === undefined ? undefined : U.log(String(r));
  const f = [], lists = [];
  let more = false;
  for (const [k, v] of Object.entries(r)) {
    if (scalar(v)) f.push([label(k), typeof v === 'boolean' ? M.yes(v) : cell(v, 100)]);
    else if (Array.isArray(v) && v.every(scalar)) f.push([label(k), v.join(', ')]);
    else if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) lists.push([k, v]);
    else more = true;
  }
  if (f.length) M.fields(f);
  for (const [k, v] of lists) { U.log(`\n${U.c.bold(label(k))}`); rows(v); }
  if (more || lists.length) U.log(U.c.dim('\n  Everything: --json'));
}

// One command = one API call. d: { group, summary, usage, description, options, examples, flags, method, path(c) | path,
// need (positionals the command needs: a leading ref is taken only beyond them), branch (false: production ref only),
// body(c), query(c), confirm(c) | confirm (destructive: asks, --yes skips; a falsy answer of confirm(c) asks nothing), done(r, c) (✓ line), show(r, c) }.
// c = { flags, args, ref }.
function cmd(d) {
  return {
    group: d.group, summary: d.summary, usage: d.usage, description: d.description, options: d.options, examples: d.examples, flags: d.flags,
    async run({ flags, args }) {
      const ref = refOf(flags, args, d.need || 0, { allowBranch: d.branch !== false });
      const c = { flags, args, ref };
      const tail = typeof d.path === 'function' ? d.path(c) : d.path;
      const body = d.body ? await d.body(c) : undefined;
      const query = d.query ? d.query(c) : undefined;
      if (d.before) await d.before(c);
      const question = typeof d.confirm === 'function' ? d.confirm(c) : d.confirm;
      if (question) await M.confirm(flags, question);
      const r = await call(d.method, `/projects/${ref}${tail}`, { body, query });
      U.output(r, () => {
        if (d.done) U.ok(d.done(r, c));
        if (d.show) d.show(r, c);
        else if (!d.done) show(r);
      });
      return r;
    },
  };
}

module.exports = { refOf, call, setPath, input, needBody, need, intArg, matchArg, enc, isoTime, tableArg, cell, rows, show, cmd };
