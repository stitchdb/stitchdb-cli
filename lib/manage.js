// Helpers shared by the Management API commands (projects, orgs, settings, integrations): which project or
// organization a command works on, key=value and duration flags, JSON files and small output helpers.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const C = require('./config');
const api = require('./api');

const REF_RE = /^[a-z]{16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The project: a ref given as the first positional argument, else --project-ref / the linked project.
function projectRef(flags, args = [], { allowBranch = true, positional = true } = {}) {
  if (positional && args[0] && REF_RE.test(args[0])) return args.shift();
  return C.targetRef(flags, C.project(flags, { required: false }), { allowBranch });
}

// The organization: --org <id or name>, else STITCHDB_ORG_ID, else the only organization of the account.
async function orgId(flags) {
  const want = flags.org || process.env.STITCHDB_ORG_ID;
  if (want && UUID_RE.test(want)) return want.toLowerCase();
  const list = await api.get('/organizations');
  if (want) {
    const hit = list.filter((o) => String(o.name || '').toLowerCase() === String(want).toLowerCase());
    if (hit.length === 1) return hit[0].id;
    U.fail(hit.length ? `More than one organization is called "${want}".` : `No organization "${want}".`, { hint: 'Run "stitchdb orgs list" and pass --org <id>.' });
  }
  if (list.length === 1) return list[0].id;
  if (!list.length) U.fail('This account has no organization.');
  U.fail(`You are in ${list.length} organizations: choose one with --org <id>.`, { hint: list.map((o) => `  ${o.id}  ${o.name} (${o.role})`).join('\n') });
}

// "key=value" pairs -> object. Values: null removes, true/false/numbers become JSON values when `typed`.
function pairs(list, { typed = true, what = 'key=value' } = {}) {
  const out = {};
  for (const item of [].concat(list || [])) {
    const i = String(item).indexOf('=');
    if (i <= 0) U.fail(`"${item}" is not ${what}.`);
    const k = item.slice(0, i).trim(), v = item.slice(i + 1).trim();
    out[k] = typed ? value(v) : v === 'null' || v === '' ? null : v;
  }
  return out;
}
function value(v) {
  if (v === 'null' || v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{"]/.test(v)) { try { return JSON.parse(v); } catch {} }
  return v;
}

// "90", "90s", "15m", "2h", "7d", "1w" -> seconds.
function seconds(s, what = 'duration') {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/i.exec(String(s ?? '').trim());
  if (!m) U.fail(`${what} must be a number of seconds or like 15m, 2h, 7d (got "${s}").`);
  return Math.round(Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[(m[2] || 's').toLowerCase()]);
}

function readJson(file) {
  let text;
  try { text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8'); } catch (e) { U.fail(`Cannot read ${file}: ${e.code || e.message}`); }
  try { return JSON.parse(text); } catch (e) { U.fail(`${file} is not valid JSON: ${e.message}`); }
}
const readText = (file) => { try { return fs.readFileSync(path.resolve(file), 'utf8'); } catch (e) { return U.fail(`Cannot read ${file}: ${e.code || e.message}`); } };

async function confirm(flags, question) {
  if (!(await U.confirm(question, { yes: flags.yes }))) U.fail('Cancelled.', { code: 2, hint: process.stdin.isTTY ? undefined : 'Pass --yes to confirm without a terminal.' });
}

// Aligned "Label   value" lines.
function fields(rows) {
  const list = rows.filter((r) => r && r[1] !== undefined);
  const w = Math.max(0, ...list.map((r) => r[0].length));
  for (const [k, v] of list) U.log(`  ${U.c.bold(k.padEnd(w))}  ${v === null || v === '' ? U.c.dim('-') : v}`);
}

const bytes = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};
const num = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
const usd = (micros) => (micros == null ? '' : `${micros < 0 ? '-' : ''}$${(Math.abs(micros) / 1e6).toFixed(2)}`);
const date = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '');
const yes = (b) => (b ? U.c.green('yes') : 'no');
const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : '');

// Find one item by id (or id prefix) or by another field; fails with the candidates when nothing or several match.
function pick(items, needle, { by = [], what = 'item' } = {}) {
  if (!needle) U.fail(`Give the ${what}.`);
  const n = String(needle).toLowerCase();
  let hit = items.filter((x) => String(x.id || '').toLowerCase() === n);
  if (!hit.length) hit = items.filter((x) => by.some((f) => String(x[f] ?? '').toLowerCase() === n));
  if (!hit.length && n.length >= 4) hit = items.filter((x) => String(x.id || '').toLowerCase().startsWith(n));
  if (hit.length === 1) return hit[0];
  U.fail(hit.length ? `"${needle}" matches more than one ${what}; use the full id.` : `No ${what} "${needle}".`);
}

module.exports = { REF_RE, UUID_RE, projectRef, orgId, pairs, value, seconds, readJson, readText, confirm, fields, bytes, num, usd, date, yes, list, pick };
