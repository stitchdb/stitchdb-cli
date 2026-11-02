// projects get|create|update|delete|pause|restore, projects api-keys rotate, projects limits [set], projects usage|metrics,
// projects tokens list|create|revoke, projects claim-links list|create|revoke, region-move status|start|cancel, billing estimate
'use strict';
const U = require('../util');
const C = require('../config');
const api = require('../api');
const M = require('../manage');

const STATUS = (p) => (p.paused_at ? U.c.yellow('paused') : p.status === 'active' ? U.c.green('active') : p.status === 'failed' ? U.c.red('failed') : U.c.yellow(p.status || ''));
const labelsText = (l) => Object.entries(l || {}).map(([k, v]) => `${k}=${v}`).join(', ');
const ORG = { org: { type: 'string' } };

function showProject(p) {
  M.fields([['Ref', p.ref], ['Name', p.name], ['Status', STATUS(p)], ['Region', p.region], ['Organization', p.organization_id], ['API URL', p.api_url],
    ['Created', M.date(p.created_at)], ['Labels', labelsText(p.labels)], ['Expires', p.expires_at ? M.date(p.expires_at) : null],
    p.paused_at ? ['Paused', `${M.date(p.paused_at)}${p.delete_at ? ` (deleted ${M.date(p.delete_at)} unless restored)` : ''}`] : null,
    p.parent_ref ? ['Branch of', `${p.parent_ref} (${p.git_branch})`] : null,
    p.template_status ? ['Template', p.template_status === 'failed' ? U.c.red(`failed: ${p.template_error}`) : p.template_status] : null,
    p.status_detail && p.status !== 'active' ? ['Detail', p.status_detail] : null,
    Object.keys(p.limits || {}).length ? ['Caps', Object.entries(p.limits).map(([k, v]) => `${k}=${v}`).join(', ')] : null,
    p.db ? ['Database', `${p.db.host}:${p.db.session_port} (session) / ${p.db.transaction_port} (pooled), db ${p.db.database}`] : null]);
}

// Labels from --label k=v (repeatable; k=null or k= removes on update).
const labelsFrom = (list) => (list ? M.pairs(list, { typed: false, what: 'key=value (a label)' }) : undefined);
function expiryFrom(flags, body) {
  if (flags.ttl !== undefined && flags.expiresAt !== undefined) U.fail('Pass --ttl or --expires-at, not both.');
  if (flags.ttl !== undefined) body.ttl_seconds = M.seconds(flags.ttl, '--ttl');
  if (flags.expiresAt !== undefined) body.expires_at = ['never', 'none', 'null', ''].includes(String(flags.expiresAt)) ? null : String(flags.expiresAt);
}

async function waitReady(ref, { timeout = 15 * 60000 } = {}) {
  const t0 = Date.now();
  const sp = U.spinner('Waiting for the project (database, API, Auth)…');
  try {
    for (;;) {
      const p = await api.get(`/projects/${ref}`);
      if (p.status === 'failed') U.fail(`The project could not be set up: ${p.status_detail || 'unknown error'}`);
      if (p.template_status === 'failed') U.fail(`The template could not be applied: ${p.template_error || 'unknown error'}`, { hint: 'The project exists; fix the template and apply it with "stitchdb db push", or delete the project.' });
      if (p.status === 'active' && p.template_status !== 'pending') return p;
      if (Date.now() - t0 > timeout) U.fail('The project is taking too long to get ready.', { hint: `Follow it with "stitchdb projects get ${ref}".` });
      await U.sleep(3000);
    }
  } finally { sp.stop(); }
}

module.exports = {
  'projects get': {
    group: 'Projects', summary: 'Show a project (status, region, labels, limits, connection)',
    usage: '[ref]',
    description: 'Without a ref: the linked project (or --project-ref). The service_role key and database password are only included for admin-level credentials (--json).',
    examples: 'stitchdb projects get\nstitchdb projects get abcdefghijklmnop --json',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const p = await api.get(`/projects/${ref}`);
      U.output(p, showProject);
      return p;
    },
  },
  'projects create': {
    group: 'Projects', summary: 'Create a project (optionally from a template, with labels, caps and an expiry)',
    usage: '<name> [--region <region>] [--org <id>] [--label k=v] [--ttl 7d] [--wait]',
    description: `Returns at once while the project is provisioned; --wait waits until it is ready.
A template sets up the schema: copy another project of the same organization (--from-project, optionally with --data masked|full),
use this folder's stitchdb/migrations (--migrations) or a SQL file (--sql-file); --seed-file runs once afterwards.
--file <json> sends a full request body (fields set by flags win).`,
    options: `--region <region>          Region (default: the organization's default)
--org <id|name>            Organization (default: your only one; required when you have several)
--label <key=value>        Label, repeatable (--label env=preview --label customer=42)
--ttl <duration>           Delete the project automatically after 5m..365d (e.g. 2h, 7d)
--expires-at <iso time>    ...or at this time
--limit <key=value>        Per-project cap below the plan, repeatable (--limit api_rps=20)
--from-project <ref>       Template: copy this project's migrations (or schema)
--data <masked|full>       With --from-project: also copy rows (masked personal data, or an exact copy)
--tables <list>            With --data: only these tables (schema.table, comma separated)
--migrations               Template: the migrations in ./stitchdb/migrations
--sql-file <file>          Template: run this SQL file
--seed-file <file>         Run this SQL once after the schema
--file <json>              Request body from a JSON file
--wait                     Wait until the project is ready`,
    examples: 'stitchdb projects create "Acme staging" --label env=staging --ttl 7d --wait\nstitchdb projects create tenant-42 --from-project abcdefghijklmnop --data masked --json',
    flags: { ...ORG, region: { type: 'string' }, label: { type: 'array' }, ttl: { type: 'string' }, expiresAt: { type: 'string' }, limit: { type: 'array' },
      fromProject: { type: 'string' }, data: { type: 'string' }, tables: { type: 'array' }, migrations: { type: 'boolean' }, sqlFile: { type: 'string' }, seedFile: { type: 'string' },
      file: { type: 'string' }, wait: { type: 'boolean' } },
    async run({ flags, args }) {
      const body = flags.file ? M.readJson(flags.file) : {};
      if (args[0]) body.name = args.join(' ');
      if (!body.name) U.fail('Give the project a name: stitchdb projects create <name>');
      if (flags.region) body.region = flags.region;
      if (flags.org) body.organization_id = await M.orgId(flags);
      if (flags.label) body.labels = { ...(body.labels || {}), ...labelsFrom(flags.label) };
      if (flags.limit) body.limits = { ...(body.limits || {}), ...M.pairs(flags.limit) };
      expiryFrom(flags, body);
      const tpl = { ...(body.template || {}) };
      if (flags.fromProject) tpl.from_project = flags.fromProject;
      if (flags.data) { if (!['masked', 'full', 'none'].includes(flags.data)) U.fail('--data is masked, full or none.'); tpl.data = flags.data; }
      if (flags.tables) tpl.tables = flags.tables;
      if (flags.migrations) {
        const proj = C.project(flags);
        const list = require('../migrations').readLocal(proj.migrationsDir);
        if (!list.length) U.fail('stitchdb/migrations has no migrations.');
        tpl.migrations = list.map(({ version, name, sql }) => ({ version, name, sql }));
      }
      if (flags.sqlFile) tpl.sql = M.readText(flags.sqlFile);
      if (flags.seedFile) tpl.seed = M.readText(flags.seedFile);
      if (Object.keys(tpl).length) body.template = tpl;
      let p = await api.post('/projects', body);
      U.ok(`Created ${U.c.bold(p.name)} (${p.ref}) in ${p.region || 'the default region'}.`);
      if (flags.wait) { p = await waitReady(p.ref); U.ok(`Ready: ${p.api_url}`); }
      else U.log(`It takes about a minute to get ready. Follow it with ${U.c.cyan(`stitchdb projects get ${p.ref}`)}, or link it: ${U.c.cyan(`stitchdb link --project-ref ${p.ref}`)}.`);
      return p;
    },
  },
  'projects update': {
    group: 'Projects', summary: 'Rename a project, change its labels or its expiry',
    usage: '[ref] [--name <name>] [--label k=v] [--ttl <duration> | --expires-at <iso|never>]',
    options: `--name <name>              New name
--label <key=value>        Set a label, repeatable; key=null (or key=) removes it
--ttl <duration>           Expire this long from now (5m..365d)
--expires-at <iso|never>   Expire at this time; never removes the expiry
--file <json>              Request body from a JSON file`,
    examples: 'stitchdb projects update --name "Acme production"\nstitchdb projects update abcdefghijklmnop --label env=prod --label tmp=null --expires-at never',
    flags: { name: { type: 'string' }, label: { type: 'array' }, ttl: { type: 'string' }, expiresAt: { type: 'string' }, file: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const body = flags.file ? M.readJson(flags.file) : {};
      if (flags.name !== undefined) body.name = String(flags.name);
      if (flags.label) body.labels = { ...(body.labels || {}), ...labelsFrom(flags.label) };
      expiryFrom(flags, body);
      if (!Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --name, --label, --ttl or --expires-at.' });
      const p = await api.patch(`/projects/${ref}`, body);
      U.output(p, () => { U.ok(`Updated ${p.name} (${p.ref}).`); showProject(p); });
      return p;
    },
  },
  'projects delete': {
    group: 'Projects', summary: 'Delete a project with its database, files and functions (not reversible)',
    usage: '<ref> [--yes]',
    description: 'The ref must be given explicitly (the linked project is never deleted implicitly). Preview branches: "stitchdb branches delete".',
    async run({ flags, args }) {
      const ref = args[0] || flags.projectRef;
      if (!ref) U.fail('Give the reference of the project to delete: stitchdb projects delete <ref>');
      if (!M.REF_RE.test(ref)) U.fail(`"${ref}" is not a project reference (16 lowercase letters).`);
      const p = await api.get(`/projects/${ref}`);
      if (p.parent_ref) U.fail(`${ref} is a preview branch.`, { hint: `Delete it with "stitchdb branches delete ${p.git_branch || ref}".` });
      await M.confirm(flags, `Delete project ${p.name} (${ref}) with its database, files and functions? This cannot be undone.`);
      const r = await api.del(`/projects/${ref}`);
      const proj = C.project(flags, { required: false });
      if (proj?.linkedRef === ref) for (const f of ['project-ref', 'branch-ref', 'branch-name']) proj.writeTemp(f, null);
      U.ok(`Deleted ${p.name} (${ref}).`);
      return r;
    },
  },
  'projects pause': {
    group: 'Projects', summary: 'Pause a project (services stop, data is kept)',
    usage: '[ref] [--yes]',
    description: 'While paused the API answers 503. "stitchdb projects restore" starts it again.',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      await M.confirm(flags, `Pause ${ref}? Its API stops answering until it is restored.`);
      const r = await api.post(`/projects/${ref}/pause`, {});
      U.ok(r.already ? `${ref} was already paused.` : `Paused ${ref}.`);
      return r;
    },
  },
  'projects restore': {
    group: 'Projects', summary: 'Restore a paused project',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.post(`/projects/${ref}/restore`, {});
      U.ok(r && r.restored === false ? `${ref} is not paused.` : `Restoring ${ref}: it is back in a minute.`);
      return r;
    },
  },
  'projects api-keys rotate': {
    group: 'Projects', summary: 'Rotate the anon and service_role keys',
    usage: '[ref] [--grace 24h] [--yes]',
    description: `New anon and service_role keys. The old keys keep working for the grace period (default 24h, at most 7d; 0 = refuse them at once).
Linked Vercel projects get the new keys automatically.`,
    options: '--grace <duration>   How long the old keys keep working (0, 30m, 24h, 7d)',
    flags: { grace: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const grace = flags.grace === undefined ? undefined : M.seconds(flags.grace, '--grace');
      await M.confirm(flags, `Rotate the API keys of ${ref}? Apps must switch to the new keys${grace === 0 ? ' now (the old keys stop at once)' : ' before the grace period ends'}.`);
      const r = await api.post(`/projects/${ref}/api-keys/rotate`, grace === undefined ? {} : { grace_seconds: grace });
      U.output(r, () => {
        U.ok('Rotated the API keys.');
        M.fields([['anon', r.anon_key], ['service_role', r.service_key], ['Old keys until', M.date(r.previous_keys_valid_until)]]);
      });
      return r;
    },
  },
  'projects limits': {
    group: 'Projects', summary: 'Show plan limits, per-project caps and effective limits',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.get(`/projects/${ref}/limits`);
      U.output(r, () => {
        U.log(`Plan: ${U.c.bold(r.plan)}`);
        U.table(['LIMIT', 'PLAN', 'CAP', 'EFFECTIVE'], (r.cappable || Object.keys(r.effective || {})).map((k) => [k, r.plan_limits?.[k] ?? '', r.caps?.[k] ?? '', r.effective?.[k] ?? '']));
        U.log(U.c.dim('  Set a cap with "stitchdb projects limits set <key>=<value>" (null removes it).'));
      });
      return r;
    },
  },
  'projects limits set': {
    group: 'Projects', summary: 'Set per-project caps (lower than the plan; null removes a cap)',
    usage: '[ref] <key=value>... [--file caps.json]',
    examples: 'stitchdb projects limits set api_rps=20 db_size_mb=500\nstitchdb projects limits set api_rps=null',
    flags: { file: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const body = { ...(flags.file ? M.readJson(flags.file) : {}), ...M.pairs(args) };
      if (!Object.keys(body).length) U.fail('Give at least one cap, like api_rps=20.', { hint: 'See the keys with "stitchdb projects limits".' });
      const r = await api.patch(`/projects/${ref}/limits`, body);
      U.output(r, () => {
        U.ok('Caps saved and applied.');
        U.table(['CAP', 'VALUE', 'EFFECTIVE'], Object.keys(r.caps || {}).map((k) => [k, r.caps[k], r.effective?.[k] ?? '']));
      });
      return r;
    },
  },
  'projects usage': {
    group: 'Projects', summary: 'Daily usage of a project (requests, egress, sizes, users)',
    usage: '[ref] [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
    description: 'Default: the last 30 days. At most 400 days.',
    flags: { from: { type: 'string' }, to: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.get(`/projects/${ref}/usage`, { query: { from: flags.from, to: flags.to } });
      U.output(r, () => {
        U.log(`${U.c.bold(ref)}  ${r.from} → ${r.to}`);
        if (r.current) M.fields([['Database', M.bytes(r.current.db_bytes)], ['Storage', M.bytes(r.current.storage_bytes)], ['Auth users', M.num(r.current.auth_users)], ['MAU', M.num(r.current.mau)], ['Function calls (month)', M.num(r.current.function_invocations_month)]]);
        U.table(['DAY', 'REQUESTS', '5XX', 'EGRESS', 'DATABASE', 'STORAGE', 'MAU', 'FUNCTIONS'], (r.days || []).map((d) => [d.day, M.num(d.requests), M.num(d.errors_5xx), M.bytes(d.egress_bytes), M.bytes(d.db_bytes), M.bytes(d.storage_bytes), M.num(d.mau), M.num(d.function_invocations)]));
        const t = r.totals || {};
        U.log(`  ${U.c.bold('Total')}  ${M.num(t.requests)} requests, ${M.bytes(t.egress_bytes)} egress, ${M.num(t.function_invocations)} function calls`);
      });
      return r;
    },
  },
  'projects metrics': {
    group: 'Projects', summary: 'Connections, requests, CPU and memory over time',
    usage: '[ref] [--range 1h|24h|7d|30d|13mo]',
    description: 'Shows the latest value and the peak of each series per server; --json returns every point.',
    flags: { range: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      if (flags.range && !['1h', '24h', '7d', '30d', '13mo'].includes(flags.range)) U.fail('--range is 1h, 24h, 7d, 30d or 13mo.');
      const r = await api.get(`/projects/${ref}/metrics`, { query: { range: flags.range || '24h' } });
      const SERIES = [['ca', 'Active connections'], ['pc', 'Pooler clients'], ['rq', 'Requests/s'], ['er', '5xx %'], ['rt', 'Realtime connections'], ['db', 'Database MB'], ['cp', 'CPU %'], ['mm', 'Memory MB'], ['lg', 'Replication lag s']];
      U.output(r, () => {
        U.log(`${U.c.bold(ref)}  range ${r.range}, one point every ${r.step >= 3600 ? r.step / 3600 + 'h' : r.step / 60 + 'm'}`);
        if (!r.nodes?.length) { U.log(U.c.dim('  No data yet.')); return; }
        for (const n of r.nodes) {
          U.log(`\n${U.c.bold(n.name || n.node_id)} ${U.c.dim(`(${n.role}${n.region ? ', ' + n.region : ''})`)}`);
          const rows = [];
          for (const [k, label] of SERIES) {
            const vals = (n.points || []).map((p) => p[k]).filter((v) => v !== null && v !== undefined);
            if (vals.length) rows.push([label, String(+vals.at(-1).toFixed(2)), String(+Math.max(...vals).toFixed(2))]);
          }
          U.table(['SERIES', 'LATEST', 'PEAK'], rows);
        }
        const L = r.limits || {};
        U.log(U.c.dim(`\n  Limits: ${['direct_connections', 'pooler_clients', 'db_size_mb', 'realtime_connections', 'api_rps'].filter((k) => L[k] != null).map((k) => `${k}=${L[k]}`).join(', ')}`));
      });
      return r;
    },
  },

  // ----- short-lived project tokens -----
  'projects tokens list': {
    group: 'Projects', summary: 'Active short-lived project tokens',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const list = await api.get(`/projects/${ref}/tokens`);
      U.output(list, (rows) => U.table(['ID', 'NAME', 'SCOPES', 'EXPIRES', 'LAST USED'], rows.map((t) => [t.id, t.name, M.list(t.scopes), M.date(t.expires_at), t.last_used_at ? U.ago(t.last_used_at) : ''])));
      return list;
    },
  },
  'projects tokens create': {
    group: 'Projects', summary: 'Mint a short-lived token for one project (shown once)',
    usage: '[ref] [--name <name>] [--scopes <list>] [--expires-in 1h] [--ip <list>]',
    description: `A bearer token (sdb_prj_…) for this project only, for a CI job, an agent or a customer's tool. It expires after 60s..24h (default 1h)
and has at most the rights of the credential that mints it.`,
    options: `--name <name>            Name shown in the list
--scopes <list>          Comma separated, e.g. projects:read,database:read (default: what you may grant)
--expires-in <duration>  60s..24h (default 1h)
--ip <list>              Only accept the token from these IPv4 addresses or ranges`,
    examples: 'stitchdb projects tokens create --name ci --scopes database:read,database:write --expires-in 30m',
    flags: { name: { type: 'string' }, scopes: { type: 'array' }, expiresIn: { type: 'string' }, ip: { type: 'array' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const body = { name: flags.name, scopes: flags.scopes, expires_in: flags.expiresIn === undefined ? undefined : M.seconds(flags.expiresIn, '--expires-in'), ip_allowlist: flags.ip };
      const r = await api.post(`/projects/${ref}/tokens`, body);
      U.output(r, () => {
        U.ok(`Created token ${r.name} (expires ${M.date(r.expires_at)}). It is shown only once:`);
        U.log(`\n  ${r.token}\n`);
        M.fields([['Scopes', M.list(r.scopes)], ['ID', r.id]]);
      });
      return r;
    },
  },
  'projects tokens revoke': {
    group: 'Projects', summary: 'Revoke a project token',
    usage: '[ref] <token id> [--yes]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      let id = args[0];
      if (!id) U.fail('Give the token id (see "stitchdb projects tokens list").');
      if (!M.UUID_RE.test(id)) id = M.pick(await api.get(`/projects/${ref}/tokens`), id, { by: ['name'], what: 'token' }).id;
      await M.confirm(flags, `Revoke token ${id}?`);
      const r = await api.del(`/projects/${ref}/tokens/${id}`);
      U.ok(`Revoked ${id}.`);
      return r;
    },
  },

  // ----- claim links -----
  'projects claim-links list': {
    group: 'Projects', summary: 'Claim links of a project',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const list = await api.get(`/projects/${ref}/claim-links`);
      const state = (c) => (c.used_at ? 'claimed' : c.revoked_at ? 'revoked' : new Date(c.expires_at) < new Date() ? 'expired' : U.c.green('open'));
      U.output(list, (rows) => U.table(['ID', 'STATE', 'KEEP ROLE', 'EXPIRES', 'NOTE'], rows.map((c) => [c.id, state(c), c.keep_role || '', M.date(c.expires_at), c.note || ''])));
      return list;
    },
  },
  'projects claim-links create': {
    group: 'Projects', summary: 'Create a link that hands the project to another account',
    usage: '[ref] [--expires-in-days 7] [--keep-role admin|developer|read_only] [--note <text>] [--yes]',
    description: `Whoever opens the link while signed in moves the project into their organization. Organization owners only.
With --keep-role your organization stays on the project with that role.`,
    options: `--expires-in-days <n>   1..30 (default 7)
--keep-role <role>      Stay on the project as admin, developer or read_only
--note <text>           Shown to the person claiming`,
    flags: { expiresInDays: { type: 'string' }, keepRole: { type: 'string' }, note: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      await M.confirm(flags, `Anyone who opens the link can take over ${ref}. Create it?`);
      const r = await api.post(`/projects/${ref}/claim-links`, { expires_in_days: flags.expiresInDays === undefined ? undefined : Number(flags.expiresInDays), keep_role: flags.keepRole, note: flags.note });
      U.output(r, () => { U.ok(`Claim link (expires ${M.date(r.expires_at)}), shown only once:`); U.log(`\n  ${r.url}\n`); });
      return r;
    },
  },
  'projects claim-links revoke': {
    group: 'Projects', summary: 'Revoke an unused claim link',
    usage: '[ref] <link id> [--yes]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      let id = args[0];
      if (!id) U.fail('Give the claim link id (see "stitchdb projects claim-links list").');
      if (!M.UUID_RE.test(id)) id = M.pick(await api.get(`/projects/${ref}/claim-links`), id, { what: 'claim link' }).id;
      await M.confirm(flags, `Revoke claim link ${id}?`);
      const r = await api.del(`/projects/${ref}/claim-links/${id}`);
      U.ok(`Revoked ${id}.`);
      return r;
    },
  },

  // ----- region moves -----
  'region-move status': {
    group: 'Projects', summary: 'Regions a project can move to, the allowance and the current move',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const r = await api.get(`/projects/${ref}/region-move`);
      U.output(r, () => {
        M.fields([['Region', r.region], ['Moves this month', `${r.allowance?.used ?? 0} of ${r.allowance?.limit ?? 0}`], ['Quiet hour', M.date(r.quiet_at)], r.blocked ? ['Blocked', U.c.yellow(r.blocked)] : null]);
        if (r.move) {
          U.log(`\n${U.c.bold('Move')} ${r.move.from_region || ''} → ${r.move.region}: ${r.move.status}${r.move.run_at ? ` (at ${M.date(r.move.run_at)})` : ''}${r.move.error ? ' ' + U.c.red(r.move.error) : ''}`);
          for (const s of r.move.steps || []) U.log(`  ${s.status === 'done' ? U.c.green('✓') : s.status === 'running' ? U.c.cyan('›') : s.status === 'failed' ? U.c.red('✗') : ' '} ${s.title}`);
        }
        U.log('');
        U.table(['REGION', 'AVAILABLE', 'DATABASE', 'ESTIMATE'], (r.regions || []).map((x) => [x.region, x.available ? U.c.green('yes') : U.c.dim(x.reason || 'no'), x.estimate ? M.bytes(x.estimate.db_bytes) : '', x.estimate ? `~${Math.max(1, Math.round(x.estimate.seconds))}s read-only` : '']));
      });
      return r;
    },
  },
  'region-move start': {
    group: 'Projects', summary: 'Move a project to another region (now, at the quiet hour, or later)',
    usage: '[ref] <region> [--when now|quiet|<iso time>] [--yes]',
    description: 'The project keeps its ref, URL and keys. During the switch-over writes pause for a few seconds.',
    options: '--when <now|quiet|time>   When to move (default now; quiet = the least busy hour; or a time within 14 days)',
    flags: { when: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const region = args[0];
      if (!region) U.fail('Give the target region.', { hint: `See the choices with "stitchdb region-move status${flags.projectRef ? ' --project-ref ' + ref : ''}".` });
      const when = flags.when || 'now';
      await M.confirm(flags, `Move ${ref} to ${region} (${when})?`);
      const r = await api.post(`/projects/${ref}/region-move`, { region, when });
      U.output(r, () => { U.ok(`Move to ${r?.region || region} ${r?.status === 'scheduled' && when !== 'now' ? `scheduled for ${M.date(r.run_at)}` : 'started'}.`); U.log(`Follow it with ${U.c.cyan('stitchdb region-move status')}.`); });
      return r;
    },
  },
  'region-move cancel': {
    group: 'Projects', summary: 'Cancel a scheduled region move',
    usage: '[ref] [--yes]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      await M.confirm(flags, `Cancel the scheduled move of ${ref}?`);
      const r = await api.del(`/projects/${ref}/region-move`);
      U.ok('Cancelled the move.');
      return r;
    },
  },

  // ----- billing -----
  'billing estimate': {
    group: 'Billing', summary: 'What a change would cost (extra project, plan, branch, replica, PITR, spend cap)',
    usage: '--type <project|plan|branch|replica|pitr|spend-cap> [--plan <id>] [--count <n>] [--off]',
    description: 'Estimates for the organization that owns --project-ref (or the linked project), else your own account. Nothing is changed.',
    options: `--type <type>     project, plan, branch, replica, pitr or spend-cap
--plan <id>       With --type plan: the plan to compare with
--count <n>       With --type replica: number of replicas
--off             With pitr or spend-cap: turning it off`,
    examples: 'stitchdb billing estimate --type project\nstitchdb billing estimate --type plan --plan scale --json',
    flags: { type: { type: 'string' }, plan: { type: 'string' }, count: { type: 'string' }, off: { type: 'boolean' } },
    async run({ flags }) {
      const type = String(flags.type || '').replace('-', '_');
      if (!['project', 'plan', 'branch', 'replica', 'pitr', 'spend_cap'].includes(type)) U.fail('--type is project, plan, branch, replica, pitr or spend-cap.');
      if (type === 'plan' && !flags.plan) U.fail('--type plan needs --plan <id>.');
      const proj = C.project(flags, { required: false });
      const ref = flags.projectRef || proj?.linkedRef || process.env.STITCHDB_PROJECT_REF || undefined;
      const change = { type };
      if (flags.plan) change.plan_id = flags.plan;
      if (flags.count !== undefined) change.count = Number(flags.count);
      if (type === 'pitr' || type === 'spend_cap') change.on = !flags.off;
      if (ref && (type === 'branch')) change.project_ref = ref;
      if (ref && (type === 'replica')) change.ref = ref;
      const r = await api.post('/billing/estimate', { project_ref: ref, change });
      U.output(r, () => {
        U.log(r.allowed === false ? U.c.yellow(r.summary) : r.summary);
        M.fields([['Plan', r.plan?.name], ['Monthly', r.monthly_micros != null ? M.usd(r.monthly_micros) : undefined], ['Charged now', r.now_micros != null ? M.usd(r.now_micros) : undefined],
          ['Spend cap', r.spend_cap === undefined ? undefined : r.spend_cap ? 'on' : 'off'], ...(r.warnings || []).map((w) => ['Warning', U.c.yellow(w)])]);
      });
      return r;
    },
  },
  _internal: { waitReady, labelsFrom, expiryFrom },
};
