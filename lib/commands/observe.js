// Operations and observability on the management API: logs, logs query, log-drains *, webhooks *, advisors,
// inspect queries, security exposure|settings, db check, functions logs|versions|stats|usage|rollback|update.
'use strict';
const fs = require('fs');
const U = require('../util');
const C = require('../config');
const api = require('../api');

// ---------- shared helpers (also used by agents.js and apps.js) ----------
const refOf = (flags) => C.targetRef(flags, C.project(flags, { required: false }));
const P = (ref, path = '') => `/projects/${ref}${path}`;
const enc = encodeURIComponent;
// "15m", "2h", "3d", "1w" (ago) or an ISO date / time.
function when(v, what = 'time') {
  if (v == null || v === '' || v === true) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d|w)$/i.exec(String(v).trim());
  if (m) return new Date(Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, min: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()]).toISOString();
  const t = Date.parse(v);
  if (Number.isNaN(t)) U.fail(`--${what}: a date and time (2026-10-01T12:00:00Z) or a duration ago (15m, 2h, 3d).`);
  return new Date(t).toISOString();
}
function need(v, msg, hint) { if (v == null || v === '' || v === true) U.fail(msg, hint ? { hint } : undefined); return v; }
async function sure(question, flags) { if (!(await U.confirm(question, { yes: flags.yes }))) U.fail('Cancelled.', { code: 2 }); }
function jsonFlag(v, name) {
  if (v === undefined) return undefined;
  try { return JSON.parse(v); } catch { return U.fail(`--${name} must be JSON (got ${String(v).slice(0, 60)}).`); }
}
const list = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const num = (v, name) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isFinite(n)) U.fail(`--${name} must be a number.`); return n; };
const cut = (s, n = 60) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const ts = (d) => { if (!d) return ''; const t = new Date(d); return Number.isNaN(t.getTime()) ? String(d) : t.toISOString().replace('T', ' ').slice(0, 19); };
const LEVEL = { error: U.c.red, danger: U.c.red, critical: U.c.red, warn: U.c.yellow, warning: U.c.yellow, info: U.c.cyan, debug: U.c.gray, ok: U.c.green };
const lvl = (l) => (LEVEL[l] || String)(String(l || ''));
function kv(pairs) {
  const w = Math.max(...pairs.map(([k]) => k.length)) + 2;
  for (const [k, v] of pairs) if (v !== undefined && v !== null && v !== '') U.log(`  ${U.c.bold(k.padEnd(w))}${typeof v === 'object' ? JSON.stringify(v) : v}`);
}
// --enable / --disable → enabled: true / false (undefined when neither).
function enabledOf(flags) {
  if (flags.enable && flags.disable) U.fail('Pass --enable or --disable, not both.');
  return flags.enable ? true : flags.disable ? false : undefined;
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
// Exit code 1 (output unchanged) when a finding is at or above --fail-on.
function failOn(flags, levels, found) {
  if (!flags.failOn) return;
  const at = levels.indexOf(flags.failOn);
  if (at < 0) U.fail(`--fail-on is one of ${levels.join(', ')}.`);
  if (found.some((l) => levels.indexOf(l) >= 0 && levels.indexOf(l) <= at)) process.exitCode = 1;
}
const H = { refOf, P, enc, when, need, sure, jsonFlag, list, num, cut, ts, lvl, kv, enabledOf, clean, failOn };

// ---------- logs ----------
const SOURCES = ['api', 'auth', 'rest', 'postgres', 'functions'];
function logLine(r, source) {
  const extra = source === 'functions' && r.function ? U.c.dim(`[${r.function}${r.version ? ' v' + r.version : ''}] `) : '';
  return `${U.c.gray(ts(r.t))} ${lvl((r.l || 'info').padEnd(5))} ${extra}${String(r.m ?? '')}`;
}
// Polls with since = the newest time seen; lines at exactly that time that were already shown are skipped.
async function follow(fetchPage, { timeOf, keyOf, print, interval = 3, polls = Infinity, start }) {
  let last = start, seen = new Set();
  for (let i = 0; i < polls; i++) {
    if (i) await U.sleep(interval * 1000);
    const rows = (await fetchPage(last)).slice().reverse(); // oldest first
    for (const r of rows) {
      const t = timeOf(r), k = keyOf(r);
      if (last && t < last) continue;
      if (t === last && seen.has(k)) continue;
      if (t !== last) { last = t; seen = new Set(); }
      seen.add(k);
      print(r);
    }
  }
}
const ndjson = (r) => process.stdout.write(JSON.stringify(r) + '\n');

const LOG_FLAGS = { source: { type: 'string', alias: 's' }, level: { type: 'string', alias: 'l' }, status: { type: 'string' }, search: { type: 'string', alias: 'q' },
  since: { type: 'string' }, until: { type: 'string' }, limit: { type: 'string', alias: 'n' }, cursor: { type: 'string' }, follow: { type: 'boolean', alias: 'f' },
  interval: { type: 'string' }, polls: { type: 'string' } };

module.exports = {
  logs: {
    group: 'Logs and monitoring', summary: 'Search the project\'s logs (API, Auth, REST, Postgres, Edge Functions)',
    usage: '[--source api|auth|rest|postgres|functions] [--level <lvl>] [--search <words>] [--since 1h] [--follow]',
    description: `Newest lines last. Without --since the search goes back as far as your plan keeps logs, in pages:
the last line printed says how to get the next page (--cursor). --follow keeps printing new lines (Ctrl+C stops).`,
    options: `-s, --source <name>     api (default), auth, rest, postgres or functions
-l, --level <level>     Lowest level: debug, info, warn or error
    --status <code>     HTTP status (404) or class (5xx), for api and auth
-q, --search <words>    Lines that contain every word ("quoted phrase" too)
    --since <time>      ISO time, or a duration ago: 15m, 2h, 3d
    --until <time>      ISO time, or a duration ago
-n, --limit <n>         Lines per page (default 100, at most 1000)
    --cursor <c>        The next page of an earlier search
-f, --follow            Keep polling for new lines
    --interval <s>      Seconds between polls with --follow (default 3)`,
    examples: `stitchdb logs --level error --since 1h
stitchdb logs -s postgres -q "deadlock detected"
stitchdb logs -s api --status 5xx --follow
stitchdb logs -s functions --since 15m --json`,
    flags: LOG_FLAGS,
    async run({ flags }) {
      const ref = refOf(flags);
      const source = flags.source || 'api';
      if (!SOURCES.includes(source)) U.fail(`--source is one of ${SOURCES.join(', ')}.`);
      const q = { source, level: flags.level, status: flags.status, q: flags.search, until: when(flags.until, 'until'), limit: flags.limit };
      if (flags.follow) {
        const since = when(flags.since, 'since') || new Date(Date.now() - 60e3).toISOString();
        await follow((s) => api.get(P(ref, '/logs'), { query: { ...q, since: s, until: undefined, limit: 1000 } }).then((r) => r.lines || []), {
          start: since, interval: num(flags.interval, 'interval') || 3, polls: flags.polls ? Number(flags.polls) : Infinity,
          timeOf: (r) => r.t, keyOf: (r) => JSON.stringify(r), print: (r) => (U.state.json ? ndjson(r) : U.log(logLine(r, source))) });
        return undefined;
      }
      const r = await api.get(P(ref, '/logs'), { query: { ...q, since: when(flags.since, 'since'), cursor: flags.cursor } });
      U.output(r, () => {
        const lines = (r.lines || []).slice().reverse();
        if (!lines.length) U.log(U.c.dim(`  No ${source} log lines${flags.since ? ' in that time' : ''}.`));
        for (const l of lines) U.log(logLine(l, source));
        if (r.warning) U.warn(r.warning);
        if (r.next) U.log(U.c.dim(`Older lines: stitchdb logs -s ${source} --cursor "${r.next}"${flags.level ? ' -l ' + flags.level : ''}${flags.search ? ` -q ${JSON.stringify(flags.search)}` : ''}`));
        U.log(U.c.dim(`Logs are kept ${r.retention_days} day(s) on this plan.`));
      });
      return r;
    },
  },
  'logs query': {
    group: 'Logs and monitoring', summary: 'Ask SQL-like questions over the logs (counts, percentiles, top paths)',
    usage: '"<SELECT … FROM api|auth|rest|postgres|functions …>" [--since 1h] [--until <time>]',
    description: `Read-only and never against your database: a SELECT over one log source, evaluated on the platform.
Fields: t, l (level), m (message), minute, hour, and per source (api: method, path, status, status_class, ms, bytes,
ip, ua, id; auth: method, path, status, component, action, error_code, event; postgres: severity, user, pid;
functions: function, version, kind, execution_id). Aggregates: count, count_distinct, sum, avg, min, max, p50, p90,
p95, p99. One query covers at most 24 hours (default: the last hour).`,
    options: `--since <time>   ISO time, or a duration ago (15m, 2h)
--until <time>   ISO time, or a duration ago
-f, --file <f>   Read the query from a file`,
    examples: `stitchdb logs query "select status, count(*) as n, p95(ms) from api where status >= 500 group by status order by n desc"
stitchdb logs query "select path, count(*) as n from api group by path order by n desc limit 10" --since 24h
stitchdb logs query "select function, count(*) from functions where l = 'error' group by function" --json`,
    flags: { since: { type: 'string' }, until: { type: 'string' }, file: { type: 'string', alias: 'f' } },
    async run({ flags, args }) {
      const ref = refOf(flags);
      const query = flags.file ? fs.readFileSync(flags.file, 'utf8') : args.join(' ');
      need(query.trim(), 'Give the query.', 'stitchdb logs query "select count(*) from api where status >= 500"');
      const r = await api.post(P(ref, '/logs/query'), clean({ query, since: when(flags.since, 'since'), until: when(flags.until, 'until') }));
      U.output(r, () => {
        const cols = r.columns || Object.keys(r.rows?.[0] || {});
        U.table(cols.map((c) => String(c).toUpperCase()), (r.rows || []).map((row) => cols.map((c) => { const v = Array.isArray(row) ? row[cols.indexOf(c)] : row[c]; return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : cut(v, 80); })));
        U.log(U.c.dim(`${r.source}, ${ts(r.since)} – ${ts(r.until)} UTC${r.scanned ? `, ${r.scanned.lines} lines scanned` : ''}${r.total_rows ? `, ${r.total_rows} rows (first ${r.rows.length} shown)` : ''}`));
        for (const n of r.notes || []) U.warn(n);
      });
      return r;
    },
  },

  // ---------- log drains ----------
  'log-drains list': {
    group: 'Logs and monitoring', summary: 'List the log drains (logs sent to your own log service)',
    async run({ flags }) {
      const r = await api.get(P(refOf(flags), '/log-drains'));
      U.output(r, () => {
        U.table(['NAME', 'ID', 'KIND', 'DESTINATION', 'SOURCES', 'LEVEL', 'STATUS', 'SENT'], (r.drains || []).map((d) => [d.name, d.id, d.kind,
          cut(d.config?.url || d.config?.site || '', 40), (d.sources || []).join(','), d.min_level, d.status === 'failing' ? U.c.red('failing') : d.status === 'ok' ? U.c.green('ok') : d.status, String(d.sent)]));
        U.log(U.c.dim(`${(r.drains || []).length} of ${r.limit} drains on this plan.`));
        for (const d of r.drains || []) if (d.last_error && d.status === 'failing') U.warn(`${d.name}: ${d.last_error}`);
      });
      return r;
    },
  },
  'log-drains create': {
    group: 'Logs and monitoring', summary: 'Send the project\'s logs to an HTTPS endpoint, Datadog or Loki',
    usage: '--name <name> --kind http|datadog|loki [destination options] [--sources api,postgres] [--min-level warn]',
    description: `About once a minute, the new log lines go to the drain (gzip'ed batches, retried when the service fails).
http: a JSON array per batch, signed with the drain's signing secret (shown once). Plan limit: log drains per project.`,
    options: `--name <name>            A name for the drain
--kind <kind>            http, datadog or loki
--url <url>              http and loki: the endpoint (https)
--headers <json>         http: extra headers, e.g. '{"Authorization":"Bearer …"}'
--site <site>            datadog: datadoghq.com (default), datadoghq.eu, us3.datadoghq.com, …
--api-key <key>          datadog: the API key
--service <name>         datadog: the service tag     --tags <tags>  datadog: extra tags (env:prod,team:web)
--username <u>           loki: the user (Grafana Cloud)  --password <p>  loki: the token / password
--tenant <id>            loki: X-Scope-OrgID
--sources <list>         api, auth, rest, postgres, functions (default all)
--min-level <level>      debug, info (default), warn or error
--disable                Create it switched off`,
    examples: `stitchdb log-drains create --name datadog --kind datadog --api-key "$DD_API_KEY" --site datadoghq.eu
stitchdb log-drains create --name errors --kind http --url https://logs.example.com/ingest --min-level error`,
    flags: drainFlags(),
    async run({ flags }) {
      const body = drainBody(flags, true);
      const r = await api.post(P(refOf(flags), '/log-drains'), body);
      U.ok(`Created log drain ${U.c.bold(r.name)} (${r.id}).`);
      if (r.signing_secret) U.output(r, () => U.log(`  Signing secret (shown once): ${U.c.bold(r.signing_secret)}`));
      return r;
    },
  },
  'log-drains update': {
    group: 'Logs and monitoring', summary: 'Change a log drain (destination, sources, level, on / off)',
    usage: '<id> [--name] [--url] [--api-key] [--sources] [--min-level] [--enable|--disable]',
    description: 'Options as for "log-drains create". Secrets left out keep their stored value. The kind cannot change.',
    flags: drainFlags(),
    async run({ flags, args }) {
      const id = need(args[0], 'Give the drain id (stitchdb log-drains list).');
      const r = await api.patch(P(refOf(flags), `/log-drains/${enc(id)}`), drainBody(flags, false));
      U.ok(`Updated log drain ${U.c.bold(r.name)} (${r.status}).`);
      return r;
    },
  },
  'log-drains delete': {
    group: 'Logs and monitoring', summary: 'Delete a log drain (lines waiting for it are dropped)',
    usage: '<id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the drain id (stitchdb log-drains list).');
      await sure(`Delete log drain ${id}?`, flags);
      const r = await api.del(P(refOf(flags), `/log-drains/${enc(id)}`));
      U.ok(`Deleted log drain ${id}.`);
      return r;
    },
  },
  'log-drains test': {
    group: 'Logs and monitoring', summary: 'Send a test line to a log drain now',
    usage: '<id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the drain id (stitchdb log-drains list).');
      const r = await api.post(P(refOf(flags), `/log-drains/${enc(id)}/test`), {});
      if (r.ok) U.ok(`The service accepted the test line${r.status ? ` (${r.status})` : ''}${r.ms != null ? ` in ${r.ms} ms` : ''}.`);
      else { U.warn(`The test failed: ${r.error || `status ${r.status}`}`); process.exitCode = 1; }
      return r;
    },
  },

  // ---------- webhooks ----------
  'webhooks list': {
    group: 'Webhooks', summary: 'List the project\'s database and Auth event webhooks',
    async run({ flags }) {
      const r = await api.get(P(refOf(flags), '/webhooks'));
      U.output(r, () => {
        U.table(['NAME', 'ID', 'URL', 'EVENTS', 'STATUS', 'PENDING', 'DEAD', '24H'], (r.webhooks || []).map((h) => [h.name, h.id, cut(h.url, 40), cut((h.events || []).join(','), 36),
          !h.enabled ? U.c.yellow(h.disabled_reason ? 'disabled' : 'off') : h.failing_since ? U.c.red('failing') : U.c.green('on'),
          String(h.stats?.pending ?? ''), String(h.stats?.dead ?? ''), String(h.stats?.delivered_24h ?? '')]));
        if (r.limits) U.log(U.c.dim(`${(r.webhooks || []).length} of ${r.limits.webhooks} webhooks; ${r.usage?.events_month ?? 0} of ${r.limits.events_month} events this month; deliveries kept ${r.limits.log_days} days.`));
      });
      return r;
    },
  },
  'webhooks get': {
    group: 'Webhooks', summary: 'Show one webhook',
    usage: '<id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id (stitchdb webhooks list).');
      const h = pickHook(await api.get(P(refOf(flags), `/webhooks/${enc(id)}`)));
      U.output(h, () => kv([['Name', h.name], ['ID', h.id], ['URL', h.url], ['Events', (h.events || []).join(', ')], ['Tables', (h.tables || []).join(', ')],
        ['Enabled', String(h.enabled)], ['Disabled', h.disabled_reason], ['Failing since', h.failing_since && ts(h.failing_since)], ['Created', ts(h.created_at)]]));
      return h;
    },
  },
  'webhooks create': {
    group: 'Webhooks', summary: 'Create a webhook (signed POSTs on database and Auth events)',
    usage: '--name <name> --url https://… --events <list> [--tables <list>] [--headers <json>]',
    description: `Events: db.insert, db.update, db.delete (choose --tables), auth.user.created, auth.user.confirmed,
auth.user.signed_in, auth.user.updated, auth.user.deleted, types.updated, budget.alert, crash.issue.new,
crash.issue.regressed, monitor.down, monitor.failed, monitor.long, monitor.recovered, health.alert, health.recovered,
metering.threshold. Each delivery is signed (StitchDB-Webhook-Signature: v1=HMAC-SHA256(secret, "<timestamp>.<body>"));
the secret is shown once ("webhooks secret" shows it again).`,
    options: `--name <name>      A name
--url <url>        The https endpoint
--events <list>    Comma-separated events
--tables <list>    Tables for db.* events (schema.table; public. is the default schema)
--headers <json>   Extra headers sent with every delivery
--disable          Create it switched off`,
    examples: `stitchdb webhooks create --name orders --url https://api.example.com/hooks --events db.insert,db.update --tables orders
stitchdb webhooks create --name signups --url https://example.com/hook --events auth.user.created`,
    flags: hookFlags(),
    async run({ flags }) {
      const body = hookBody(flags);
      need(body.name, 'Give the webhook a --name.'); need(body.url, 'Give the endpoint: --url https://…'); need(body.events, 'Choose the --events (comma-separated).');
      const r = await api.post(P(refOf(flags), '/webhooks'), { ...body, enabled: body.enabled !== false });
      U.ok(`Created webhook ${U.c.bold(r.name)} (${r.id}).`);
      U.output(r, () => {
        U.log(`  Signing secret (shown once): ${U.c.bold(r.secret)}`);
        if (r.missing_tables?.length) U.warn(`These tables do not exist yet: ${r.missing_tables.join(', ')} (events start when they do).`);
      });
      return r;
    },
  },
  'webhooks update': {
    group: 'Webhooks', summary: 'Change a webhook (URL, events, tables, headers, on / off)',
    usage: '<id> [--name] [--url] [--events] [--tables] [--headers <json>] [--enable|--disable]',
    flags: hookFlags(),
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id (stitchdb webhooks list).');
      const body = hookBody(flags);
      if (!Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --url, --events, --tables, --headers, --name, --enable or --disable.' });
      const r = await api.patch(P(refOf(flags), `/webhooks/${enc(id)}`), body);
      U.ok(`Updated webhook ${U.c.bold(r.name)}.`);
      if (r.missing_tables?.length) U.warn(`These tables do not exist yet: ${r.missing_tables.join(', ')}.`);
      return r;
    },
  },
  'webhooks delete': {
    group: 'Webhooks', summary: 'Delete a webhook and its delivery log',
    usage: '<id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id (stitchdb webhooks list).');
      await sure(`Delete webhook ${id} and its queued deliveries?`, flags);
      const r = await api.del(P(refOf(flags), `/webhooks/${enc(id)}`));
      U.ok(`Deleted webhook ${id}.`);
      return r;
    },
  },
  'webhooks secret': {
    group: 'Webhooks', summary: 'Show a webhook\'s signing secret',
    usage: '<id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id (stitchdb webhooks list).');
      const r = await api.get(P(refOf(flags), `/webhooks/${enc(id)}/secret`));
      U.output(r, () => U.log(r.secret));
      return r;
    },
  },
  'webhooks rotate-secret': {
    group: 'Webhooks', summary: 'Give a webhook a new signing secret (the old one stops working)',
    usage: '<id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id (stitchdb webhooks list).');
      await sure(`Rotate the signing secret of webhook ${id}? Deliveries are signed with the new one right away.`, flags);
      const r = await api.post(P(refOf(flags), `/webhooks/${enc(id)}/rotate-secret`), {});
      U.ok('New signing secret:');
      U.output(r, () => U.log(`  ${U.c.bold(r.secret)}`));
      return r;
    },
  },
  'webhooks test': {
    group: 'Webhooks', summary: 'Send a test.ping event to a webhook now and show the answer',
    usage: '<id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id (stitchdb webhooks list).');
      const r = await api.post(P(refOf(flags), `/webhooks/${enc(id)}/test`), {});
      U.output(r, () => {
        if (r.ok) U.ok(`The endpoint answered ${r.status} in ${r.duration_ms} ms.`);
        else U.warn(`The endpoint ${r.status ? `answered ${r.status}` : `failed: ${r.error}`}${r.duration_ms != null ? ` (${r.duration_ms} ms)` : ''}.`);
        if (r.response) U.log(U.c.dim(cut(r.response, 300)));
      });
      if (!r.ok) process.exitCode = 1;
      return r;
    },
  },
  'webhooks deliveries': {
    group: 'Webhooks', summary: 'List a webhook\'s deliveries (newest first)',
    usage: '<id> [--status pending|delivered|dead] [--limit 50] [--before <time>]',
    flags: { status: { type: 'string' }, limit: { type: 'string', alias: 'n' }, before: { type: 'string' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id (stitchdb webhooks list).');
      const r = await api.get(P(refOf(flags), `/webhooks/${enc(id)}/deliveries`), { query: { status: flags.status, limit: flags.limit, before: when(flags.before, 'before') } });
      const st = { delivered: U.c.green('delivered'), dead: U.c.red('dead'), pending: U.c.yellow('pending') };
      U.output(r, () => U.table(['ID', 'EVENT', 'TABLE', 'STATUS', 'TRIES', 'LAST', 'CREATED'], r.map((d) => [d.id, d.type, d.table || '', st[d.status] || d.status,
        String(d.attempts), d.last_status ? String(d.last_status) : cut(d.last_error || '', 30), U.ago(d.created_at)])));
      return r;
    },
  },
  'webhooks delivery': {
    group: 'Webhooks', summary: 'Show one delivery (payload, response, every attempt)',
    usage: '<webhook id> <delivery id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id and the delivery id.');
      const did = need(args[1], 'Give the delivery id (stitchdb webhooks deliveries <id>).');
      const d = await api.get(P(refOf(flags), `/webhooks/${enc(id)}/deliveries/${enc(did)}`));
      U.output(d, () => {
        kv([['Event', `${d.type} (${d.event_id})`], ['Status', d.status], ['Attempts', String(d.attempts)], ['Last status', d.last_status], ['Last error', d.last_error],
          ['Created', ts(d.created_at)], ['Delivered', d.delivered_at && ts(d.delivered_at)], ['Next try', d.next_at && ts(d.next_at)]]);
        U.log(U.c.bold('\n  Payload')); U.log(JSON.stringify(d.payload, null, 2).replace(/^/gm, '  '));
        if (d.response) { U.log(U.c.bold('\n  Response')); U.log('  ' + cut(d.response, 2000)); }
      });
      return d;
    },
  },
  'webhooks replay': {
    group: 'Webhooks', summary: 'Send deliveries again (one, or every dead one since a time)',
    usage: '<id> [--delivery <delivery id>] [--status dead|delivered|all] [--since <time>]',
    options: `--delivery <id>   Only this delivery
--status <s>      Which deliveries: dead (default), delivered or all
--since <time>    Only deliveries created since then (ISO time or 2h, 3d)`,
    flags: { delivery: { type: 'string' }, status: { type: 'string' }, since: { type: 'string' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the webhook id (stitchdb webhooks list).');
      if (!flags.delivery) await sure(`Send every ${flags.status || 'dead'} delivery of webhook ${id}${flags.since ? ` since ${flags.since}` : ''} again?`, flags);
      const r = await api.post(P(refOf(flags), `/webhooks/${enc(id)}/replay`), clean({ delivery_id: flags.delivery, status: flags.delivery ? undefined : flags.status, since: when(flags.since, 'since') }));
      U.ok(`Queued ${r.replayed} deliver${r.replayed === 1 ? 'y' : 'ies'} again.`);
      return r;
    },
  },

  // ---------- advisors, query performance, security ----------
  advisors: {
    group: 'Logs and monitoring', summary: 'Security, performance and health advice for the project',
    usage: '[security|performance|health|all] [--fail-on error|warn|info]',
    description: 'The same checks as Studio\'s Advisors: Row Level Security gaps, missing indexes, unused indexes, error rates and more, each with a fix.',
    options: `--fail-on <level>   Exit with code 1 when a finding is at this level or worse (CI)
--sql               Print the fix SQL of every finding`,
    examples: 'stitchdb advisors\nstitchdb advisors security --fail-on error\nstitchdb advisors performance --json',
    flags: { failOn: { type: 'string' }, sql: { type: 'boolean' } },
    async run({ flags, args }) {
      const type = args[0] || 'all';
      if (!['security', 'performance', 'health', 'all'].includes(type)) U.fail('The type is security, performance, health or all.');
      const r = await api.get(P(refOf(flags), type === 'all' ? '/advisors' : `/advisors/${type}`));
      const found = r.findings || [];
      U.output(r, () => {
        if (!found.length) U.ok(`No ${type === 'all' ? '' : type + ' '}findings.`);
        for (const f of found) {
          U.log(`${lvl((f.level || '').padEnd(5))} ${U.c.dim(`[${f.category}]`)} ${f.title}`);
          if (f.detail) U.log(U.c.dim(`      ${f.detail}`));
          if (flags.sql && f.fix_sql) U.log(f.fix_sql.replace(/^/gm, '      '));
          else if (f.next_step) U.log(U.c.dim(`      → ${f.next_step}`));
        }
        for (const n of r.notes || []) U.warn(n);
      });
      failOn(flags, ['error', 'warn', 'info'], found.map((f) => f.level));
      return r;
    },
  },
  'inspect queries': {
    group: 'Logs and monitoring', summary: 'The slowest and most frequent queries of the database',
    usage: '[--sort total|mean|calls|rows|io] [--limit 20]',
    description: 'From the database\'s statement statistics: your own roles, agents and the API roles (platform internals are left out).',
    options: `--sort <by>   total (time, default), mean, calls, rows or io (blocks read)
-n, --limit <n>   How many (default 20, at most 200)`,
    flags: { sort: { type: 'string' }, limit: { type: 'string', alias: 'n' } },
    async run({ flags }) {
      const r = await api.get(P(refOf(flags), '/database/query-performance'), { query: { sort: flags.sort, limit: flags.limit || 20 } });
      U.output(r, () => {
        if (!r.available) { U.warn('Query statistics are not available on this database.'); return; }
        const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(v < 10 ? 2 : 0)} ms`);
        U.table(['TOTAL', 'SHARE', 'CALLS', 'MEAN', 'ROWS/CALL', 'ROLE', 'QUERY'], (r.queries || []).map((q) => [ms(q.total_ms), `${Math.round(q.share * 100)}%`, String(Math.round(q.calls)),
          ms(q.mean_ms), q.rows_per_call.toFixed(q.rows_per_call < 10 ? 1 : 0), q.role, cut(q.query, 70)]));
        if (r.since) U.log(U.c.dim(`Since ${ts(r.since)} UTC. Reset with "stitchdb inspect queries reset".`));
      });
      return r;
    },
  },
  'inspect queries reset': {
    group: 'Logs and monitoring', summary: 'Reset the database\'s query statistics',
    async run({ flags }) {
      const ref = refOf(flags);
      await sure(`Reset the query statistics of ${ref}?`, flags);
      const r = await api.del(P(ref, '/database/query-performance'));
      U.ok('Query statistics reset.');
      return r;
    },
  },
  'security exposure': {
    group: 'Security', summary: 'What anonymous and signed-in visitors can read and change (live test)',
    usage: '[--fresh] [--fail-on critical|warning|info]',
    description: `Checks every table and view the API exposes: Row Level Security, policies, grants, then a live test as an
anonymous visitor and as a random signed-in user (inside transactions that are always rolled back).`,
    options: `--fresh             Run the check again (results are cached for 30 seconds)
--fail-on <level>   Exit with code 1 when a finding is at this level or worse (CI)
--sql               Print the fix SQL`,
    flags: { fresh: { type: 'boolean' }, failOn: { type: 'string' }, sql: { type: 'boolean' } },
    async run({ flags }) {
      const r = await api.get(P(refOf(flags), '/security/exposure'), { query: { fresh: flags.fresh ? 1 : undefined } });
      U.output(r, () => {
        const s = r.summary || {};
        if (!(r.findings || []).length) U.ok('Nothing is exposed.');
        for (const f of r.findings || []) {
          U.log(`${lvl((f.severity || '').padEnd(8))} ${f.title}`);
          if (f.detail) U.log(U.c.dim(`         ${f.detail}`));
          if (flags.sql && f.fix_sql) U.log(f.fix_sql.replace(/^/gm, '         '));
        }
        U.log(U.c.dim(`${s.critical || 0} critical, ${s.warning || 0} warnings, ${s.info || 0} notes.`));
      });
      failOn(flags, ['critical', 'warning', 'info'], (r.findings || []).map((f) => f.severity));
      return r;
    },
  },
  'security settings': {
    group: 'Security', summary: 'Show the RLS guard and the exposure gate for migrations',
    async run({ flags }) {
      const r = await api.get(P(refOf(flags), '/security/settings'));
      U.output(r, () => kv([['RLS guard', r.rls_guard ? 'on (new tables get Row Level Security)' : 'off'], ['Migrations', r.enforce === 'block' ? 'blocked when they expose a table (enforce = block)' : 'not checked (enforce = off)'],
        ['Updated', r.updated_at && `${ts(r.updated_at)}${r.updated_by ? ` by ${r.updated_by}` : ''}`]]));
      return r;
    },
  },
  'security settings update': {
    group: 'Security', summary: 'Turn the RLS guard or the migration exposure gate on or off',
    usage: '[--rls-guard | --no-rls-guard] [--enforce off|block]',
    options: `--rls-guard / --no-rls-guard   Enable Row Level Security on every new table automatically
--enforce <off|block>          block: refuse migrations that leave a table exposed`,
    flags: { rlsGuard: { type: 'boolean' }, enforce: { type: 'string' } },
    async run({ flags }) {
      const body = clean({ rls_guard: flags.rlsGuard, enforce: flags.enforce });
      if (!Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --rls-guard, --no-rls-guard or --enforce off|block.' });
      if (body.enforce && !['off', 'block'].includes(body.enforce)) U.fail('--enforce is off or block.');
      const r = await api.patch(P(refOf(flags), '/security/settings'), body);
      U.ok(`RLS guard ${r.rls_guard ? 'on' : 'off'}, migrations ${r.enforce === 'block' ? 'blocked when they expose a table' : 'not checked'}.`);
      return r;
    },
  },
  'db check': {
    group: 'Database', summary: 'What SQL would lock and for how long, before you run it (nothing runs)',
    usage: '"<sql>" | -f <file> [--fail-on warn|danger]',
    description: `Parses each statement with the Postgres parser and reports the tables it locks, what the lock blocks, the
estimated time from the tables' sizes, transactions it would queue behind, and a safer version where one exists
(CREATE INDEX CONCURRENTLY, NOT VALID + VALIDATE, batched updates …).`,
    options: `-f, --file <file>      Read the SQL from a file (a migration)
    --fail-on <level>  Exit with code 1 at warn or danger (CI)
    --safer            Print only the safer SQL`,
    examples: 'stitchdb db check "alter table orders add column note text not null default \'\'"\nstitchdb db check -f stitchdb/migrations/20261101120000_index.sql --fail-on danger',
    flags: { file: { type: 'string', alias: 'f' }, failOn: { type: 'string' }, safer: { type: 'boolean' } },
    async run({ flags, args }) {
      const query = flags.file ? fs.readFileSync(flags.file, 'utf8') : args.join(' ');
      need(query.trim(), 'Give the SQL, or -f <file>.');
      const r = await api.post(P(refOf(flags), '/database/query/check'), { query });
      U.output(r, () => {
        if (flags.safer) { U.log(r.safer_sql || query); return; }
        if (r.parse_error) { U.warn(`Could not parse the SQL: ${r.parse_error}`); return; }
        for (const s of r.statements || []) {
          U.log(`${lvl(s.level.padEnd(6))} ${cut(s.sql, 90)}${s.seconds ? U.c.dim(`  ~${s.seconds} s`) : ''}`);
          for (const m of s.messages || []) U.log(`       ${m}`);
          for (const n of s.notes || []) U.log(U.c.dim(`       ${n}`));
          if (s.safer) U.log(U.c.green(`       Safer: ${s.safer.why || ''}`) + `\n       ${s.safer.sql}`);
          if (s.batch) U.log(s.batch.replace(/^/gm, '       '));
        }
        U.log(r.level === 'ok' ? U.c.green('✓ No risky locks.') : `Overall: ${lvl(r.level)}`);
        if (r.safer_sql) U.log(U.c.dim('Safer version of the whole script: add --safer.'));
      });
      failOn(flags, ['danger', 'warn'], [r.level]);
      return r;
    },
  },

  // ---------- Edge Functions: logs, versions, stats, usage, rollback, update ----------
  'functions logs': {
    group: 'Edge Functions', summary: 'Logs of one Edge Function, or of all of them',
    usage: '[slug] [--level error] [--search <text>] [--since 1h] [--follow]',
    options: `-l, --level <level>   Lowest level: debug, info, warn or error (default: everything but boot lines)
-q, --search <text>   Lines that contain the text
    --since <time>    ISO time or a duration ago (15m, 2h, 3d)
    --before <time>   Lines before this time
-n, --limit <n>       How many (default 100, at most 1000)
-f, --follow          Keep polling for new lines`,
    examples: 'stitchdb functions logs hello --level error --since 1h\nstitchdb functions logs --follow',
    flags: { level: { type: 'string', alias: 'l' }, search: { type: 'string', alias: 'q' }, since: { type: 'string' }, before: { type: 'string' }, limit: { type: 'string', alias: 'n' },
      follow: { type: 'boolean', alias: 'f' }, interval: { type: 'string' }, polls: { type: 'string' } },
    async run({ flags, args }) {
      const ref = refOf(flags), slug = args[0];
      const path = P(ref, slug ? `/functions/${enc(slug)}/logs` : '/functions/logs');
      const q = { level: flags.level, search: flags.search, before: when(flags.before, 'before') };
      const line = (r) => `${U.c.gray(ts(r.ts))} ${lvl((r.level || 'info').padEnd(5))} ${slug ? '' : U.c.dim(`[${r.slug} v${r.version}] `)}${r.msg}`;
      if (flags.follow) {
        await follow((s) => api.get(path, { query: { ...q, before: undefined, since: s, limit: 1000 } }), {
          start: when(flags.since, 'since') || new Date(Date.now() - 60e3).toISOString(), interval: num(flags.interval, 'interval') || 3, polls: flags.polls ? Number(flags.polls) : Infinity,
          timeOf: (r) => new Date(r.ts).toISOString(), keyOf: (r) => JSON.stringify(r), print: (r) => (U.state.json ? ndjson(r) : U.log(line(r))) });
        return undefined;
      }
      const rows = await api.get(path, { query: { ...q, since: when(flags.since, 'since'), limit: flags.limit || 100 } });
      U.output(rows, () => { if (!rows.length) U.log(U.c.dim('  No log lines.')); for (const r of rows.slice().reverse()) U.log(line(r)); });
      return rows;
    },
  },
  'functions versions': {
    group: 'Edge Functions', summary: 'The deployed versions of a function',
    usage: '<slug>',
    async run({ flags, args }) {
      const slug = need(args[0], 'Give the function slug.');
      const ref = refOf(flags);
      const [fn, rows] = await Promise.all([api.get(P(ref, `/functions/${enc(slug)}`)), api.get(P(ref, `/functions/${enc(slug)}/versions`))]);
      U.output(rows, () => U.table(['VERSION', 'SIZE', 'SHA256', 'DEPLOYED', ''], rows.map((v) => [String(v.version), `${(v.size_bytes / 1024).toFixed(1)} kB`, String(v.sha256 || '').slice(0, 12),
        U.ago(v.created_at), v.version === fn.version ? U.c.cyan('← live') : ''])));
      return rows;
    },
  },
  'functions stats': {
    group: 'Edge Functions', summary: 'Invocations, errors and latency of a function',
    usage: '<slug> [--hours 24]',
    flags: { hours: { type: 'string' } },
    async run({ flags, args }) {
      const slug = need(args[0], 'Give the function slug.');
      const r = await api.get(P(refOf(flags), `/functions/${enc(slug)}/stats`), { query: { hours: flags.hours } });
      U.output(r, () => {
        kv([['Period', `last ${r.hours} h`], ['Invocations', String(r.invocations)], ['Errors (5xx)', String(r.errors)], ['p50', r.p50_ms != null ? `${r.p50_ms} ms` : '–'],
          ['p95', r.p95_ms != null ? `${r.p95_ms} ms` : '–'], ['Status', Object.entries(r.status || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || '–'],
          ['This month', r.month ? `${r.month.invocations} invocations, ${r.month.errors} errors (whole project)` : undefined]]);
      });
      return r;
    },
  },
  'functions usage': {
    group: 'Edge Functions', summary: 'This month\'s invocations and the plan\'s function limits',
    async run({ flags }) {
      const r = await api.get(P(refOf(flags), '/functions/usage'));
      const l = r.limits || {};
      U.output(r, () => kv([['Month', r.month], ['Invocations', `${r.invocations} of ${l.invocations_month ?? '?'}`], ['Errors', String(r.errors)], ['Functions', `${r.count} of ${l.functions ?? '?'}`],
        ['Bundle size', l.bundle_kb != null ? `up to ${l.bundle_kb} kB` : undefined], ['Memory', l.memory_mb != null ? `${l.memory_mb} MB` : undefined],
        ['Wall clock', l.wall_s != null ? `${l.wall_s} s` : undefined], ['CPU', l.cpu_ms != null ? `${l.cpu_ms} ms` : undefined]]));
      return r;
    },
  },
  'functions rollback': {
    group: 'Edge Functions', summary: 'Serve an earlier (or later) deployed version of a function',
    usage: '<slug> [version]   (default: the version before the live one)',
    async run({ flags, args }) {
      const slug = need(args[0], 'Give the function slug.');
      const ref = refOf(flags);
      const fn = await api.get(P(ref, `/functions/${enc(slug)}`));
      let version = args[1] != null ? Number(args[1]) : null;
      if (args[1] != null && !Number.isInteger(version)) U.fail('The version is a number (stitchdb functions versions <slug>).');
      if (version == null) {
        const vs = await api.get(P(ref, `/functions/${enc(slug)}/versions`));
        version = vs.map((v) => v.version).filter((v) => v < fn.version).sort((a, b) => b - a)[0];
        if (!version) U.fail(`${slug} has no version before v${fn.version}.`);
      }
      if (version === fn.version) { U.ok(`${slug} already serves v${version}.`); return fn; }
      await sure(`Serve ${slug} v${version} instead of v${fn.version}?`, flags);
      const r = await api.patch(P(ref, `/functions/${enc(slug)}`), { version });
      U.ok(`${slug} now serves v${r.version ?? version}.`);
      return r;
    },
  },
  'functions update': {
    group: 'Edge Functions', summary: 'Rename a function or change its JWT check (no deploy)',
    usage: '<slug> [--name <name>] [--verify-jwt | --no-verify-jwt]',
    flags: { name: { type: 'string' }, verifyJwt: { type: 'boolean' } },
    async run({ flags, args }) {
      const slug = need(args[0], 'Give the function slug.');
      const body = clean({ name: flags.name, verify_jwt: flags.verifyJwt });
      if (!Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --name, --verify-jwt or --no-verify-jwt.' });
      const r = await api.patch(P(refOf(flags), `/functions/${enc(slug)}`), body);
      U.ok(`Updated ${slug}: name "${r.name}", JWT check ${r.verify_jwt ? 'on' : 'off'}.`);
      return r;
    },
  },
  _observe: { hidden: true, H, follow, drainBody, hookBody, pickHook, when },
};

// ---------- body builders ----------
function drainFlags() {
  return { name: { type: 'string' }, kind: { type: 'string' }, url: { type: 'string' }, headers: { type: 'string' }, site: { type: 'string' }, apiKey: { type: 'string' },
    service: { type: 'string' }, tags: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, tenant: { type: 'string' },
    sources: { type: 'array' }, minLevel: { type: 'string' }, enable: { type: 'boolean' }, disable: { type: 'boolean' } };
}
function drainBody(flags, create) {
  const config = clean({ url: flags.url, headers: jsonFlag(flags.headers, 'headers'), site: flags.site, api_key: flags.apiKey, service: flags.service, tags: flags.tags,
    username: flags.username, password: flags.password, tenant: flags.tenant });
  if (create) {
    need(flags.name, 'Give the drain a --name.');
    need(flags.kind, 'Choose the --kind: http, datadog or loki.');
    if (!['http', 'datadog', 'loki'].includes(flags.kind)) U.fail('--kind is http, datadog or loki.');
  }
  const body = clean({ name: flags.name, kind: create ? flags.kind : undefined, sources: flags.sources, min_level: flags.minLevel,
    enabled: create ? (flags.disable ? false : undefined) : enabledOf(flags) });
  if (Object.keys(config).length) body.config = config;
  if (!create && !Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --url, --api-key, --sources, --min-level, --enable or --disable.' });
  return body;
}
function hookFlags() {
  return { name: { type: 'string' }, url: { type: 'string' }, events: { type: 'array' }, tables: { type: 'array' }, headers: { type: 'string' }, enable: { type: 'boolean' }, disable: { type: 'boolean' } };
}
function hookBody(flags) {
  return clean({ name: flags.name, url: flags.url, events: flags.events, tables: flags.tables, headers: jsonFlag(flags.headers, 'headers'), enabled: enabledOf(flags) });
}
// GET /webhooks/:id: only the public fields (never stored secrets or header values).
function pickHook(h) {
  const keep = ['id', 'name', 'url', 'events', 'tables', 'enabled', 'disabled_reason', 'failing_since', 'created_at', 'updated_at', 'stats'];
  const out = Object.fromEntries(keep.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));
  if (Array.isArray(h.headers)) out.headers = h.headers;
  return out;
}
