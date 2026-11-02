// orgs list|billing|usage|audit-log, orgs members list|update|remove, orgs invitations list|create|revoke,
// orgs tokens list|create|revoke, orgs apps list|revoke, orgs webhooks list|create|update|delete|test|rotate-secret|deliveries|redeliver
'use strict';
const fs = require('fs');
const U = require('../util');
const api = require('../api');
const M = require('../manage');

const ORG = { org: { type: 'string' } };
const ORG_HELP = '--org <id|name>   Organization (default: your only one, or STITCHDB_ORG_ID)';
const opts = (more = '') => (more ? `${ORG_HELP}\n${more}` : ORG_HELP);
const ROLES = ['admin', 'developer', 'read_only'];
const SCOPES = ['projects:read', 'projects:write', 'database:read', 'database:write', 'functions:write', 'secrets:write', 'auth:write', 'usage:read', 'webhooks:write', 'billing:read'];
const base = (id) => `/organizations/${id}`;

// "--projects all" (or none given on update with --all-projects) -> null = every project.
const projectsFlag = (v) => (v === undefined ? undefined : v.length === 1 && ['all', '*'].includes(v[0]) ? null : v);
function checkRole(r) { if (r !== undefined && !ROLES.includes(r)) U.fail(`--role is ${ROLES.join(', ')}.`); return r; }

// CSV exports (usage, audit log): stream to --file or stdout.
async function csv(path, query, file) {
  if (U.state.json && !file) U.fail('--csv writes CSV, not JSON: drop --json or pass --file <path>.');
  const res = await api.request('GET', path, { raw: true, query: { ...query, format: 'csv' } });
  const text = typeof res === 'string' ? res : await res.text();
  if (file) { fs.writeFileSync(file, text); U.ok(`Wrote ${U.rel(file)}.`); } else process.stdout.write(text);
  return { file: file || null, bytes: Buffer.byteLength(text) };
}

const memberOf = async (org, needle) => {
  const list = await api.get(`${base(org)}/members`);
  return M.pick(list.map((m) => ({ ...m, id: m.user_id })), needle, { by: ['email'], what: 'member' });
};
const webhookOf = async (org, needle) => M.pick(await api.get(`${base(org)}/webhooks`), needle, { by: ['url'], what: 'webhook' });

module.exports = {
  'orgs list': {
    group: 'Organizations', summary: 'Organizations you can act in',
    async run() {
      const list = await api.get('/organizations');
      U.output(list, (rows) => U.table(['ID', 'NAME', 'ROLE', 'PROJECTS'], rows.map((o) => [o.id, o.name, o.role, o.projects ?? ''])));
      return list;
    },
  },
  'orgs billing': {
    group: 'Organizations', summary: 'Plan, limits and billing state of an organization (owner)',
    options: opts(), flags: ORG,
    async run({ flags }) {
      const org = await M.orgId(flags);
      const r = await api.get(`${base(org)}/billing`);
      U.output(r, () => {
        M.fields([['Organization', r.organization_id], ['Plan', `${r.plan?.name}${r.plan?.price_label ? ` (${r.plan.price_label})` : ''}`], ['Projects', r.projects], ['Suspended', r.suspended ? U.c.red('yes') : 'no']]);
        U.log('');
        U.table(['LIMIT', 'VALUE'], Object.entries(r.limits || {}).map(([k, v]) => [k, v === null ? 'unlimited' : typeof v === 'object' ? JSON.stringify(v) : v]));
      });
      return r;
    },
  },
  'orgs usage': {
    group: 'Organizations', summary: 'Usage of every project of an organization in a date range',
    usage: '[--from YYYY-MM-DD] [--to YYYY-MM-DD] [--csv [--file usage.csv]]',
    description: 'Default: the last 30 days (at most 400). Traffic is summed, sizes and users are the peak of each project.',
    options: opts(`--from / --to     Date range
--csv             CSV instead of a table (to stdout, or --file)
--file <path>     Write the CSV here`),
    flags: { ...ORG, from: { type: 'string' }, to: { type: 'string' }, csv: { type: 'boolean' }, file: { type: 'string' } },
    async run({ flags }) {
      const org = await M.orgId(flags);
      const q = { from: flags.from, to: flags.to };
      if (flags.csv) return csv(`${base(org)}/usage`, q, flags.file);
      const r = await api.get(`${base(org)}/usage`, { query: q });
      U.output(r, () => {
        U.log(`${r.from} → ${r.to}`);
        U.table(['REF', 'NAME', 'REQUESTS', 'EGRESS', 'DATABASE', 'STORAGE', 'MAU', 'FUNCTIONS'], (r.projects || []).map((p) => [p.ref, p.deleted ? U.c.dim('(deleted)') : p.name, M.num(p.requests), M.bytes(p.egress_bytes), M.bytes(p.db_bytes), M.bytes(p.storage_bytes), M.num(p.mau), M.num(p.function_invocations)]));
        const t = r.totals || {};
        U.log(`  ${U.c.bold('Total')}  ${M.num(t.requests)} requests, ${M.bytes(t.egress_bytes)} egress, ${M.bytes(t.db_bytes)} database, ${M.bytes(t.storage_bytes)} storage, ${M.num(t.mau)} MAU`);
      });
      return r;
    },
  },
  'orgs audit-log': {
    group: 'Organizations', summary: 'Audit log of an organization, newest first',
    usage: '[--action <prefix>] [--actor <email>] [--project <ref>] [--since <date>] [--until <date>] [--limit 100] [--before <id>] [--csv]',
    options: opts(`--action <prefix>   member, project, api, org_token, … (prefix match)
--actor <text>      Part of the actor's e-mail
--project <ref>     Only entries about this project
--since / --until   Time range (ISO dates)
--limit <n>         1..200 (default 100)
--before <id>       Older entries than this id (paging)
--csv               CSV export (to stdout, or --file)`),
    flags: { ...ORG, action: { type: 'string' }, actor: { type: 'string' }, project: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, limit: { type: 'string' }, before: { type: 'string' }, csv: { type: 'boolean' }, file: { type: 'string' } },
    async run({ flags }) {
      const org = await M.orgId(flags);
      const q = { action: flags.action, actor: flags.actor, project: flags.project, since: flags.since, until: flags.until, limit: flags.limit, before: flags.before };
      if (flags.csv) return csv(`${base(org)}/audit-log`, q, flags.file);
      const rows = await api.get(`${base(org)}/audit-log`, { query: q });
      U.output(rows, () => {
        U.table(['ID', 'WHEN', 'ACTOR', 'ACTION', 'DESCRIPTION'], rows.map((r) => [r.id, M.date(r.at), r.actor_email || '', r.action, r.description || r.target || '']));
        if (rows.length >= (Number(flags.limit) || 100)) U.log(U.c.dim(`  Older entries: --before ${rows.at(-1).id}`));
      });
      return rows;
    },
  },

  // ----- members -----
  'orgs members list': {
    group: 'Organizations', summary: 'Members of an organization with their role',
    options: opts(), flags: ORG,
    async run({ flags }) {
      const org = await M.orgId(flags);
      const list = await api.get(`${base(org)}/members`);
      U.output(list, (rows) => U.table(['USER ID', 'E-MAIL', 'ROLE', 'PROJECTS', 'LAST SIGN-IN'], rows.map((m) => [m.user_id, m.email, m.role, m.project_refs?.length ? m.project_refs.join(', ') : 'all', m.last_sign_in_at ? U.ago(m.last_sign_in_at) : ''])));
      return list;
    },
  },
  'orgs members update': {
    group: 'Organizations', summary: "Change a member's role or project access",
    usage: '<email|user id> [--role admin|developer|read_only] [--projects <refs>|all]',
    options: opts(`--role <role>       admin, developer or read_only
--projects <list>   Only these projects (comma separated), or all`),
    flags: { ...ORG, role: { type: 'string' }, projects: { type: 'array' } },
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const m = await memberOf(org, args[0]);
      const body = { role: checkRole(flags.role), project_refs: projectsFlag(flags.projects) };
      if (body.role === undefined && body.project_refs === undefined) U.fail('Pass --role or --projects.');
      const r = await api.patch(`${base(org)}/members/${m.user_id}`, body);
      U.ok(`Updated ${m.email}.`);
      return r;
    },
  },
  'orgs members remove': {
    group: 'Organizations', summary: 'Remove a member from an organization',
    usage: '<email|user id> [--yes]',
    options: opts(), flags: ORG,
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const m = await memberOf(org, args[0]);
      await M.confirm(flags, `Remove ${m.email} from the organization? They lose access to its projects.`);
      const r = await api.del(`${base(org)}/members/${m.user_id}`);
      U.ok(`Removed ${m.email}.`);
      return r;
    },
  },

  // ----- invitations -----
  'orgs invitations list': {
    group: 'Organizations', summary: 'Pending invitations',
    options: opts(), flags: ORG,
    async run({ flags }) {
      const org = await M.orgId(flags);
      const list = await api.get(`${base(org)}/invitations`);
      U.output(list, (rows) => U.table(['ID', 'E-MAIL', 'ROLE', 'PROJECTS', 'EXPIRES', 'INVITED BY'], rows.map((i) => [i.id, i.email, i.role, i.project_refs?.length ? i.project_refs.join(', ') : 'all', i.expired ? U.c.yellow('expired') : M.date(i.expires_at), i.invited_by || ''])));
      return list;
    },
  },
  'orgs invitations create': {
    group: 'Organizations', summary: 'Invite someone by e-mail',
    usage: '<email> [--role developer] [--projects <refs>]',
    options: opts(`--role <role>       admin (owner only), developer (default) or read_only
--projects <list>   Only these projects (comma separated)`),
    flags: { ...ORG, role: { type: 'string' }, projects: { type: 'array' } },
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      if (!args[0]) U.fail('Give the e-mail address to invite.');
      const r = await api.post(`${base(org)}/invitations`, { email: args[0], role: checkRole(flags.role), project_refs: projectsFlag(flags.projects) || undefined });
      U.ok(`Invited ${args[0]}${flags.role ? ` as ${flags.role}` : ''}. The invitation was sent by e-mail.`);
      return r;
    },
  },
  'orgs invitations revoke': {
    group: 'Organizations', summary: 'Revoke a pending invitation',
    usage: '<email|invitation id> [--yes]',
    options: opts(), flags: ORG,
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const inv = M.pick(await api.get(`${base(org)}/invitations`), args[0], { by: ['email'], what: 'invitation' });
      await M.confirm(flags, `Revoke the invitation of ${inv.email}?`);
      const r = await api.del(`${base(org)}/invitations/${inv.id}`);
      U.ok(`Revoked the invitation of ${inv.email}.`);
      return r;
    },
  },

  // ----- organization tokens -----
  'orgs tokens list': {
    group: 'Organizations', summary: 'Organization access tokens',
    options: opts(), flags: ORG,
    async run({ flags }) {
      const org = await M.orgId(flags);
      const list = await api.get(`${base(org)}/tokens`);
      U.output(list, (rows) => U.table(['ID', 'NAME', 'TOKEN', 'SCOPES', 'PROJECTS', 'EXPIRES', 'LAST USED'], rows.map((t) => [t.id, t.name, t.display, M.list(t.scopes), t.project_refs?.length ? t.project_refs.join(', ') : 'all', t.expires_at ? M.date(t.expires_at) : 'never', t.last_used_at ? U.ago(t.last_used_at) : ''])));
      return list;
    },
  },
  'orgs tokens create': {
    group: 'Organizations', summary: 'Create an organization token (sdb_org_…, shown once)',
    usage: '--name <name> --scopes <list> [--projects <refs>] [--ip <list>] [--expires-in-days <n>] [--rate <per second>]',
    description: `For platforms and automation: acts in this organization with the given scopes. Only people (dashboard or a personal access token) can create tokens.
Scopes: ${SCOPES.join(', ')}.`,
    options: opts(`--name <name>            Name
--scopes <list>          Comma separated scopes (required)
--projects <list>        Only these projects
--ip <list>              Only from these IPv4 addresses or ranges
--expires-in-days <n>    1..3650 (default: never)
--rate <n>               Requests per second, 1..200 (default 20)`),
    examples: 'stitchdb orgs tokens create --name provisioning --scopes projects:read,projects:write,database:write --expires-in-days 90',
    flags: { ...ORG, name: { type: 'string' }, scopes: { type: 'array' }, projects: { type: 'array' }, ip: { type: 'array' }, expiresInDays: { type: 'string' }, rate: { type: 'string' } },
    async run({ flags }) {
      const org = await M.orgId(flags);
      if (!flags.name) U.fail('Give the token a --name.');
      if (!flags.scopes?.length) U.fail('Give the --scopes it needs.', { hint: `Scopes: ${SCOPES.join(', ')}` });
      const bad = flags.scopes.filter((s) => !SCOPES.includes(s));
      if (bad.length) U.fail(`Unknown scope ${bad.join(', ')}.`, { hint: `Scopes: ${SCOPES.join(', ')}` });
      const r = await api.post(`${base(org)}/tokens`, { name: flags.name, scopes: flags.scopes, project_refs: flags.projects, ip_allowlist: flags.ip,
        expires_in_days: flags.expiresInDays === undefined ? undefined : Number(flags.expiresInDays), rate_per_sec: flags.rate === undefined ? undefined : Number(flags.rate) });
      U.output(r, () => { U.ok(`Created ${r.name}. Copy the token now, it is shown only once:`); U.log(`\n  ${r.token}\n`); M.fields([['Scopes', M.list(r.scopes)], ['ID', r.id]]); });
      return r;
    },
  },
  'orgs tokens revoke': {
    group: 'Organizations', summary: 'Revoke an organization token (and the project tokens minted from it)',
    usage: '<id|name> [--yes]',
    options: opts(), flags: ORG,
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const t = M.pick(await api.get(`${base(org)}/tokens`), args[0], { by: ['name'], what: 'token' });
      await M.confirm(flags, `Revoke token ${t.name} (${t.display})? Everything using it stops working.`);
      const r = await api.del(`${base(org)}/tokens/${t.id}`);
      U.ok(`Revoked ${t.name}.`);
      return r;
    },
  },

  // ----- connected apps -----
  'orgs apps list': {
    group: 'Organizations', summary: 'Third-party apps connected to the organization',
    options: opts(), flags: ORG,
    async run({ flags }) {
      const org = await M.orgId(flags);
      const list = await api.get(`${base(org)}/apps`);
      U.output(list, (rows) => U.table(['ID', 'NAME', 'SCOPES', 'PROJECT TOKENS', 'CONNECTED BY', 'LAST USED'], rows.map((a) => [a.id, a.name, M.list(a.scopes), a.project_tokens ?? '', a.created_by || '', a.last_used_at ? U.ago(a.last_used_at) : ''])));
      return list;
    },
  },
  'orgs apps revoke': {
    group: 'Organizations', summary: 'Disconnect an app (its tokens stop working)',
    usage: '<id|name> [--yes]',
    options: opts(), flags: ORG,
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const a = M.pick(await api.get(`${base(org)}/apps`), args[0], { by: ['name'], what: 'app' });
      await M.confirm(flags, `Disconnect ${a.name}? Its access and the project tokens it minted stop working.`);
      const r = await api.del(`${base(org)}/apps/${a.id}`);
      U.ok(`Disconnected ${a.name}.`);
      return r;
    },
  },

  // ----- organization webhooks -----
  'orgs webhooks list': {
    group: 'Organizations', summary: 'Webhook endpoints of an organization (project, usage, member events)',
    options: opts(), flags: ORG,
    async run({ flags }) {
      const org = await M.orgId(flags);
      const list = await api.get(`${base(org)}/webhooks`);
      U.output(list, (rows) => U.table(['ID', 'URL', 'EVENTS', 'ENABLED', 'FAILING'], rows.map((w) => [w.id, w.url, M.list(w.events), w.enabled ? 'yes' : U.c.yellow(`no${w.disabled_reason ? ` (${w.disabled_reason})` : ''}`), w.failing_since ? U.c.red(U.ago(w.failing_since)) : ''])));
      return list;
    },
  },
  'orgs webhooks create': {
    group: 'Organizations', summary: 'Add a webhook endpoint (signing secret shown once)',
    usage: '<url> [--events <list>|*] [--description <text>] [--thresholds 80,100]',
    options: opts(`--events <list>        Events to send (default every event, *)
--description <text>   Note
--thresholds <list>    usage.threshold at these percentages of a limit`),
    examples: 'stitchdb orgs webhooks create https://example.com/hooks/stitchdb --events project.ready,project.failed',
    flags: { ...ORG, events: { type: 'array' }, description: { type: 'string' }, thresholds: { type: 'array' } },
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      if (!args[0]) U.fail('Give the endpoint URL (https).');
      const r = await api.post(`${base(org)}/webhooks`, { url: args[0], events: flags.events, description: flags.description, usage_thresholds: flags.thresholds?.map(Number) });
      U.output(r, () => { U.ok(`Added ${r.url}. Signing secret (shown once):`); U.log(`\n  ${r.secret}\n`); M.fields([['Events', M.list(r.events)], ['ID', r.id]]); });
      return r;
    },
  },
  'orgs webhooks update': {
    group: 'Organizations', summary: 'Change a webhook endpoint (URL, events, on/off)',
    usage: '<id|url> [--url <url>] [--events <list>] [--description <text>] [--enabled | --no-enabled] [--thresholds <list>]',
    options: opts(`--url <url>            New URL
--events <list>        Events to send
--description <text>   Note
--enabled / --no-enabled  Turn the endpoint on or off
--thresholds <list>    Usage percentages`),
    flags: { ...ORG, url: { type: 'string' }, events: { type: 'array' }, description: { type: 'string' }, enabled: { type: 'boolean' }, thresholds: { type: 'array' } },
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const w = await webhookOf(org, args[0]);
      const body = { url: flags.url, events: flags.events, description: flags.description, enabled: flags.enabled, usage_thresholds: flags.thresholds?.map(Number) };
      if (Object.values(body).every((v) => v === undefined)) U.fail('Nothing to change.', { hint: 'Pass --url, --events, --description, --enabled / --no-enabled or --thresholds.' });
      const r = await api.patch(`${base(org)}/webhooks/${w.id}`, body);
      U.ok(`Updated ${r.url}${r.enabled ? '' : ' (disabled)'}.`);
      return r;
    },
  },
  'orgs webhooks delete': {
    group: 'Organizations', summary: 'Delete a webhook endpoint and its deliveries',
    usage: '<id|url> [--yes]',
    options: opts(), flags: ORG,
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const w = await webhookOf(org, args[0]);
      await M.confirm(flags, `Delete the webhook ${w.url}?`);
      const r = await api.del(`${base(org)}/webhooks/${w.id}`);
      U.ok(`Deleted ${w.url}.`);
      return r;
    },
  },
  'orgs webhooks test': {
    group: 'Organizations', summary: 'Send a test.ping event now',
    usage: '<id|url>',
    options: opts(), flags: ORG,
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const w = await webhookOf(org, args[0]);
      const r = await api.post(`${base(org)}/webhooks/${w.id}/test`, {});
      U.output(r, () => (r.status === 'delivered' ? U.ok(`Delivered (HTTP ${r.last_status}).`) : U.warn(`Not delivered: ${r.last_error || `HTTP ${r.last_status}`} (retried later).`)));
      return r;
    },
  },
  'orgs webhooks rotate-secret': {
    group: 'Organizations', summary: 'New signing secret for an endpoint (shown once)',
    usage: '<id|url> [--yes]',
    options: opts(), flags: ORG,
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const w = await webhookOf(org, args[0]);
      await M.confirm(flags, `Rotate the signing secret of ${w.url}? Deliveries are signed with the new one at once.`);
      const r = await api.post(`${base(org)}/webhooks/${w.id}/rotate-secret`, {});
      U.output(r, () => { U.ok('New signing secret (shown once):'); U.log(`\n  ${r.secret}\n`); });
      return r;
    },
  },
  'orgs webhooks deliveries': {
    group: 'Organizations', summary: 'Recent deliveries of an endpoint',
    usage: '<id|url> [--status pending|delivered|failed] [--limit 50]',
    options: opts(`--status <status>   pending, delivered or failed
--limit <n>         1..200 (default 50)`),
    flags: { ...ORG, status: { type: 'string' }, limit: { type: 'string' } },
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const w = await webhookOf(org, args[0]);
      const list = await api.get(`${base(org)}/webhooks/${w.id}/deliveries`, { query: { status: flags.status, limit: flags.limit } });
      const st = { delivered: U.c.green('delivered'), failed: U.c.red('failed'), pending: U.c.yellow('pending') };
      U.output(list, (rows) => U.table(['ID', 'EVENT', 'STATUS', 'ATTEMPTS', 'HTTP', 'WHEN', 'ERROR'], rows.map((d) => [d.id, d.type, st[d.status] || d.status, d.attempts, d.last_status || '', U.ago(d.created_at), d.last_error || ''])));
      return list;
    },
  },
  'orgs webhooks redeliver': {
    group: 'Organizations', summary: 'Deliver an event again',
    usage: '<webhook id|url> <delivery id>',
    options: opts(), flags: ORG,
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const w = await webhookOf(org, args[0]);
      if (!args[1]) U.fail('Give the delivery id (see "stitchdb orgs webhooks deliveries").');
      const r = await api.post(`${base(org)}/webhooks/${w.id}/deliveries/${args[1]}/redeliver`, {});
      U.ok(`Delivering ${args[1]} again.`);
      return r;
    },
  },
  _internal: { projectsFlag, SCOPES },
};
