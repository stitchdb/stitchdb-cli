// AI agent access on the management API: agents keys|logins|audit|approvals|sessions.
// Agent keys (sdb_agt_…) give an agent its own Postgres role, a query firewall, approvals for risky statements,
// a query log and session undo.
'use strict';
const U = require('../util');
const api = require('../api');
const { H } = require('./observe')._observe;
const { refOf, P, enc, need, sure, jsonFlag, num, cut, ts, kv, clean } = H;

const PRESETS = ['read-only', 'app-dev', 'migrations'];
const APPROVALS = ['ddl_destructive', 'unbounded_write', 'bulk_write', 'rls_change', 'grants', 'extensions'];
const POLICY_FLAGS = { policy: { type: 'string' }, ops: { type: 'array' }, allow: { type: 'array' }, deny: { type: 'array' }, maxRows: { type: 'string' }, timeoutMs: { type: 'string' },
  requireApproval: { type: 'array' }, allowDirect: { type: 'boolean' }, allowFunctions: { type: 'boolean' }, bypassRls: { type: 'boolean' }, ipAllowlist: { type: 'array' } };
const POLICY_HELP = `--allow <patterns>          Tables the agent may touch: schema.table, schema.* (default public.*)
--deny <patterns>           Tables it may never touch
--ops <list>                select, insert, update, delete (read-only: select only)
--max-rows <n>              Most rows one statement may return or change
--timeout-ms <ms>           Statement timeout
--require-approval <list>   ${APPROVALS.join(', ')}
--allow-direct / --no-allow-direct   Direct Postgres connections with the agent's role
--allow-functions / --no-allow-functions   Calling database functions
--bypass-rls                Ignore Row Level Security (read-only and app-dev)
--ip-allowlist <ips>        Only these IPs / CIDRs may use the key
--policy <json>             The whole policy as JSON (the options above override it)`;
function policyOf(flags) {
  const base = jsonFlag(flags.policy, 'policy') || {};
  const tables = clean({ allow: flags.allow, deny: flags.deny });
  return clean({ ...base, ops: flags.ops, max_rows: num(flags.maxRows, 'max-rows'), statement_timeout_ms: num(flags.timeoutMs, 'timeout-ms'),
    require_approval: flags.requireApproval, allow_direct: flags.allowDirect, allow_functions: flags.allowFunctions, bypass_rls: flags.bypassRls,
    ...(Object.keys(tables).length ? { tables: { ...(base.tables || {}), ...tables } } : {}) });
}
const keyRow = (k) => [k.name, k.id, k.preset, k.display, (k.policy?.tables?.allow || []).join(','), k.expires_at ? ts(k.expires_at).slice(0, 10) : 'never', k.last_used_at ? U.ago(k.last_used_at) : 'never'];
const STATUS = { pending: U.c.yellow('pending'), executed: U.c.green('executed'), approved: U.c.green('approved'), rejected: U.c.red('rejected'), failed: U.c.red('failed'), expired: U.c.gray('expired') };

module.exports = {
  'agents keys list': {
    group: 'AI agents', summary: 'List the project\'s agent keys',
    async run({ flags }) {
      const rows = await api.get(P(refOf(flags), '/agent-keys'));
      U.output(rows, () => U.table(['NAME', 'ID', 'PRESET', 'KEY', 'TABLES', 'EXPIRES', 'LAST USED'], rows.map(keyRow)));
      return rows;
    },
  },
  'agents keys create': {
    group: 'AI agents', summary: 'Create an agent key (shown once) with its own database role and firewall',
    usage: '--name <name> [--preset read-only|app-dev|migrations] [policy options] [--expires-in-days 30]',
    description: `Presets: read-only (select, direct connections allowed), app-dev (select / insert / update / delete; approval
for unbounded and bulk writes), migrations (also DDL; approval for destructive DDL, RLS, grants and extensions; API and
MCP only). The token is shown once.`,
    options: `--name <name>               A name (e.g. the agent or tool)
--preset <preset>           read-only (default), app-dev or migrations
--expires-in-days <n>       Expire after n days (or --expires-at <ISO time>)
${POLICY_HELP}`,
    examples: `stitchdb agents keys create --name cursor --preset app-dev --deny public.payments --expires-in-days 30
stitchdb agents keys create --name reports --allow public.orders,public.customers --json`,
    flags: { name: { type: 'string' }, preset: { type: 'string' }, expiresInDays: { type: 'string' }, expiresAt: { type: 'string' }, ...POLICY_FLAGS },
    async run({ flags }) {
      need(flags.name, 'Give the key a --name.');
      if (flags.preset && !PRESETS.includes(flags.preset)) U.fail(`--preset is one of ${PRESETS.join(', ')}.`);
      const body = clean({ name: flags.name, preset: flags.preset || 'read-only', policy: policyOf(flags), ip_allowlist: flags.ipAllowlist,
        expires_in_days: num(flags.expiresInDays, 'expires-in-days'), expires_at: flags.expiresAt });
      const r = await api.post(P(refOf(flags), '/agent-keys'), body);
      U.ok(`Created agent key ${U.c.bold(r.name)} (${r.preset}, ${r.id}).`);
      U.output(r, () => {
        U.log(`  Token (shown once): ${U.c.bold(r.token)}`);
        if (r.connection_string) { U.log(`  Postgres: ${r.connection_string}`); U.log(U.c.dim(`  ${r.connection_note}`)); }
      });
      return r;
    },
  },
  'agents keys update': {
    group: 'AI agents', summary: 'Change an agent key\'s name, tables, limits or approvals',
    usage: '<key id> [--name <name>] [policy options] [--no-ip-allowlist]',
    description: 'Only the options given change; table lists replace the old ones. The preset cannot change.',
    options: `--name <name>   A new name\n${POLICY_HELP}\n--no-ip-allowlist   Remove the IP allowlist`,
    flags: { name: { type: 'string' }, ...POLICY_FLAGS, noIpAllowlist: { type: 'boolean' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the key id (stitchdb agents keys list).');
      const policy = policyOf(flags);
      const body = clean({ name: flags.name, ...(Object.keys(policy).length ? { policy } : {}) });
      if (flags.ipAllowlist !== undefined) body.ip_allowlist = flags.ipAllowlist;
      if (flags.noIpAllowlist) body.ip_allowlist = null;
      if (!Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --name or a policy option (stitchdb agents keys update --help).' });
      const r = await api.patch(P(refOf(flags), `/agent-keys/${enc(id)}`), body);
      U.ok(`Updated agent key ${U.c.bold(r.name)}.`);
      return r;
    },
  },
  'agents keys revoke': {
    group: 'AI agents', summary: 'Revoke an agent key (its role, logins and pending approvals end)',
    usage: '<key id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the key id (stitchdb agents keys list).');
      await sure(`Revoke agent key ${id}? Agents using it stop working right away.`, flags);
      const r = await api.del(P(refOf(flags), `/agent-keys/${enc(id)}`));
      U.ok(`Revoked agent key ${id}.`);
      return r;
    },
  },
  'agents logins list': {
    group: 'AI agents', summary: 'Temporary Postgres logins of an agent key',
    usage: '<key id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the key id (stitchdb agents keys list).');
      const r = await api.get(P(refOf(flags), `/agent-keys/${enc(id)}/db-logins`));
      U.output(r, () => U.table(['ID', 'USERNAME', 'ACTIVE', 'EXPIRES', 'CREATED', 'BY'], (r.logins || []).map((l) => [l.id, l.username, l.active ? U.c.green('yes') : U.c.gray(l.end_reason || 'no'),
        ts(l.expires_at), U.ago(l.created_at), l.created_by || ''])));
      return r;
    },
  },
  'agents logins create': {
    group: 'AI agents', summary: 'A temporary Postgres login with an agent key\'s rights (shown once)',
    usage: '<key id> [--ttl <minutes>]',
    flags: { ttl: { type: 'string' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the key id (stitchdb agents keys list).');
      const r = await api.post(P(refOf(flags), `/agent-keys/${enc(id)}/db-logins`), clean({ ttl_minutes: num(flags.ttl, 'ttl') }));
      U.ok(`Temporary login ${U.c.bold(r.username)}, until ${ts(r.expires_at)} UTC.`);
      U.output(r, () => { U.log(`  ${r.connection_string}`); if (r.note) U.log(U.c.dim(`  ${r.note}`)); });
      return r;
    },
  },
  'agents logins end': {
    group: 'AI agents', summary: 'End a temporary Postgres login now',
    usage: '<key id> <login id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the key id and the login id.');
      const lid = need(args[1], 'Give the login id (stitchdb agents logins list <key id>).');
      await sure(`End temporary login ${lid}? Its open connections are closed.`, flags);
      const r = await api.del(P(refOf(flags), `/agent-keys/${enc(id)}/db-logins/${enc(lid)}`));
      U.ok(`Ended login ${r.username || lid}.`);
      return r;
    },
  },
  'agents audit': {
    group: 'AI agents', summary: 'Every statement agents sent, with the firewall\'s verdict',
    usage: '[--key <id>] [--session <id>] [--verdict allowed|blocked|pending] [--since 1d] [--limit 100]',
    flags: { key: { type: 'string' }, session: { type: 'string' }, verdict: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string', alias: 'n' } },
    async run({ flags }) {
      const rows = await api.get(P(refOf(flags), '/agent-audit'), { query: { key: flags.key, session: flags.session, verdict: flags.verdict, since: H.when(flags.since, 'since'), limit: flags.limit } });
      const v = { blocked: U.c.red('blocked'), pending: U.c.yellow('pending') };
      U.output(rows, () => U.table(['AT', 'AGENT', 'SESSION', 'VERDICT', 'ROWS', 'MS', 'SQL'], rows.map((r) => [ts(r.at), r.agent || '', cut(r.session || '', 20), v[r.verdict] || r.verdict,
        r.rows == null ? '' : String(r.rows), r.ms == null ? '' : String(r.ms), cut(r.reason && r.verdict === 'blocked' ? `${r.sql}  (${r.reason})` : r.sql, 70)])));
      return rows;
    },
  },
  'agents approvals list': {
    group: 'AI agents', summary: 'Statements waiting for (or decided by) a human',
    usage: '[--status pending|executed|rejected|failed|expired]',
    flags: { status: { type: 'string' } },
    async run({ flags }) {
      const rows = await api.get(P(refOf(flags), '/agent-approvals'), { query: { status: flags.status } });
      U.output(rows, () => U.table(['ID', 'AGENT', 'STATUS', 'WHY', 'REQUESTED', 'SQL'], rows.map((a) => [a.id, a.agent || '', STATUS[a.status] || a.status, cut((a.reasons || []).join(','), 30),
        U.ago(a.requested_at), cut(a.sql, 60)])));
      return rows;
    },
  },
  'agents approvals get': {
    group: 'AI agents', summary: 'Show one approval request (the full SQL, why, the result)',
    usage: '<approval id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the approval id (stitchdb agents approvals list).');
      const a = await api.get(P(refOf(flags), `/agent-approvals/${enc(id)}`));
      U.output(a, () => {
        kv([['ID', a.id], ['Agent', a.agent], ['Session', a.session], ['Status', a.status], ['Why', (a.reason_labels || a.reasons || []).join('; ')], ['Rows', a.rows],
          ['Requested', ts(a.requested_at)], ['Expires', a.status === 'pending' ? ts(a.expires_at) : undefined], ['Decided', a.decided_at && `${ts(a.decided_at)} by ${a.decided_by || '?'}`],
          ['Note', a.note], ['Error', a.error]]);
        U.log(U.c.bold('\n  SQL')); U.log(String(a.sql || '').replace(/^/gm, '  '));
        if (a.result) { U.log(U.c.bold('\n  Result')); U.log(`  ${a.result.rows_changed ?? 0} rows changed`); }
      });
      return a;
    },
  },
  'agents approvals approve': {
    group: 'AI agents', summary: 'Approve a request: the statement runs now, as the agent',
    usage: '<approval id> [--note <text>]',
    flags: { note: { type: 'string' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the approval id (stitchdb agents approvals list).');
      const ref = refOf(flags);
      if (!flags.yes) {
        const a = await api.get(P(ref, `/agent-approvals/${enc(id)}`));
        U.log(String(a.sql || '').replace(/^/gm, '  '));
        await sure(`Run this statement for ${a.agent || 'the agent'} now?`, flags);
      }
      const r = await api.post(P(ref, `/agent-approvals/${enc(id)}/approve`), clean({ note: flags.note }));
      U.ok(`Approved: ${r.status}${r.result ? `, ${r.result.rows_changed ?? 0} rows changed` : ''}.`);
      return r;
    },
  },
  'agents approvals reject': {
    group: 'AI agents', summary: 'Reject a request (the statement never runs)',
    usage: '<approval id> [--note <text>]',
    flags: { note: { type: 'string' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the approval id (stitchdb agents approvals list).');
      const r = await api.post(P(refOf(flags), `/agent-approvals/${enc(id)}/reject`), clean({ note: flags.note }));
      U.ok('Rejected.');
      return r;
    },
  },
  'agents sessions list': {
    group: 'AI agents', summary: 'Agent sessions of the last 30 days (what changed, what can be undone)',
    async run({ flags }) {
      const rows = await api.get(P(refOf(flags), '/agent-sessions'));
      U.output(rows, () => U.table(['SESSION', 'AGENT', 'STATEMENTS', 'BLOCKED', 'ROWS', 'DDL', 'TABLES', 'LAST'], rows.map((s) => [cut(s.label || s.id, 30), s.agent_name || '',
        String(s.statements ?? ''), String(s.blocked ?? ''), String(s.rows ?? 0), String(s.ddl ?? 0), cut((s.tables || []).join(','), 30), U.ago(s.last_at)])));
      return rows;
    },
  },
  'agents sessions get': {
    group: 'AI agents', summary: 'The row and schema changes of one agent session',
    usage: '<session id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the session id (stitchdb agents sessions list).');
      const r = await api.get(P(refOf(flags), `/agent-sessions/${enc(id)}`));
      U.output(r, () => {
        const s = r.summary || {};
        U.log(`${U.c.bold(r.session)}: ${s.rows ?? 0} row changes, ${s.ddl ?? 0} schema changes`);
        U.table(['AT', 'TABLE', 'OP', 'KEY', 'UNDONE'], (r.changes || []).slice(0, 100).map((c) => [ts(c.at), c.tbl_name, c.op, cut(JSON.stringify(c.pk), 40), c.undone ? 'yes' : '']));
        for (const d of r.ddl || []) U.log(`  ${U.c.gray(ts(d.at))} ${cut(d.statement, 100)}${d.undone ? U.c.dim(' (undone)') : ''}`);
      });
      return r;
    },
  },
  'agents sessions revert': {
    group: 'AI agents', summary: 'Undo what an agent session changed (dry run unless --apply)',
    usage: '<session id> [--apply] [--force]',
    options: `--apply   Really undo (otherwise only shows what would be undone)
--force   Overwrite rows that changed again since the agent touched them (default: skip them)`,
    flags: { apply: { type: 'boolean' }, force: { type: 'boolean' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the session id (stitchdb agents sessions list).');
      if (flags.apply) await sure(`Undo the changes of session ${id}?`, flags);
      const r = await api.post(P(refOf(flags), `/agent-sessions/${enc(id)}/revert`), { dry_run: !flags.apply, on_conflict: flags.force ? 'force' : 'skip' });
      U.output(r, () => {
        const v = r.reverted || {};
        U.ok(`${r.dry_run ? 'Would undo' : 'Undid'} ${v.rows || 0} row changes, ${v.ddl || 0} schema changes, ${v.columns || 0} columns.`);
        for (const c of r.conflicts || []) U.warn(`Skipped ${c.table}${c.column ? '.' + c.column : ''}: ${c.reason}`);
        for (const m of r.manual || []) U.warn(`Undo by hand: ${typeof m === 'string' ? m : m.statement || JSON.stringify(m)}`);
        for (const e of r.errors || []) U.warn(`Error: ${typeof e === 'string' ? e : e.error || JSON.stringify(e)}`);
        if (r.dry_run) U.log(U.c.dim('Dry run. Add --apply to undo.'));
      });
      return r;
    },
  },
};
module.exports._agents = { hidden: true, policyOf };
