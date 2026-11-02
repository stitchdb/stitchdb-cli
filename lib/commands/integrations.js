// domains list|get|add|check|update|remove, vercel list|browse|link|update|sync|unlink,
// cloudflare list|browse|link|update|sync|unlink, github status|repos|link|unlink
'use strict';
const U = require('../util');
const api = require('../api');
const M = require('../manage');

const DSTATUS = { active: U.c.green('active'), pending: U.c.yellow('pending'), issuing: U.c.yellow('issuing'), failed: U.c.red('failed') };
const domainArg = (args) => {
  const d = String(args[0] || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) U.fail('Give the domain, like api.example.com.');
  return d;
};
const dpath = (ref, d) => `/projects/${ref}/custom-domains/${encodeURIComponent(d)}`;
function dnsHelp(target, d) {
  U.log(`\nAdd this DNS record at your DNS provider (DNS only, no proxy):`);
  U.table(['TYPE', 'NAME', 'VALUE'], [['CNAME', d, target]]);
  U.log(U.c.dim(`  Then: stitchdb domains check ${d}`));
}

// Vercel: the token comes from --token, VERCEL_TOKEN or a prompt; it is stored sealed on the server, never locally.
async function vercelToken(flags, { required = true } = {}) {
  const t = flags.token || process.env.VERCEL_TOKEN;
  if (t || !required) return t || undefined;
  return U.ask('Vercel access token:', { hidden: true });
}
async function vercelLink(ref, needle) {
  const { links = [] } = await api.get(`/projects/${ref}/integrations/vercel`);
  return M.pick(links, needle, { by: ['vercel_project_name', 'vercel_project_id'], what: 'Vercel link' });
}
const VERCEL_FLAGS = { token: { type: 'string' }, team: { type: 'string' }, targets: { type: 'array' }, prefix: { type: 'string' }, serviceKey: { type: 'boolean' }, databaseUrl: { type: 'boolean' } };
function vercelOptions(flags) {
  const b = {};
  if (flags.targets) b.targets = flags.targets;
  if (flags.prefix !== undefined) b.prefix = ['none', '""', "''"].includes(flags.prefix) ? '' : flags.prefix;
  if (flags.serviceKey !== undefined) b.service_key = flags.serviceKey;
  if (flags.databaseUrl !== undefined) b.database_url = flags.databaseUrl;
  return b;
}
const showVercel = (l) => M.fields([['Vercel project', `${l.vercel_project_name} (${l.vercel_project_id})`], ['Team', l.team_name || l.team_id], ['Targets', M.list(l.targets)],
  ['Prefix', l.prefix || '(none)'], ['service_role key', M.yes(l.service_key)], ['Database URL', M.yes(l.database_url)], ['Variables', M.list(l.variables)],
  ['Last sync', l.last_sync_at ? U.ago(l.last_sync_at) : null], l.last_error ? ['Error', U.c.red(l.last_error)] : null, ['ID', l.id]]);

// Cloudflare: the API token comes from --token, CLOUDFLARE_API_TOKEN or a hidden prompt; stored sealed on the server, never locally.
async function cfToken(flags, { required = true } = {}) {
  const t = flags.token || process.env.CLOUDFLARE_API_TOKEN;
  if (t || !required) return t || undefined;
  return U.ask('Cloudflare API token:', { hidden: true });
}
async function cfLink(ref, needle) {
  const { links = [] } = await api.get(`/projects/${ref}/integrations/cloudflare`);
  return M.pick(links, needle, { by: ['name'], what: 'Cloudflare link' });
}
const CF_FLAGS = { token: { type: 'string' }, account: { type: 'string' }, kind: { type: 'string' }, targets: { type: 'array' }, prefix: { type: 'string' },
  serviceKey: { type: 'boolean' }, databaseUrl: { type: 'boolean' }, hyperdrive: { type: 'boolean' } };
function cfOptions(flags) {
  const b = {};
  if (flags.targets) b.targets = flags.targets;
  if (flags.prefix !== undefined) b.prefix = ['none', '""', "''", true].includes(flags.prefix) ? '' : flags.prefix;
  if (flags.serviceKey !== undefined) b.service_key = flags.serviceKey;
  if (flags.databaseUrl !== undefined) b.database_url = flags.databaseUrl;
  if (flags.hyperdrive !== undefined) b.hyperdrive = flags.hyperdrive;
  return b;
}
const showCf = (l) => M.fields([['Cloudflare', `${l.kind === 'pages' ? 'Pages project' : 'Worker'} ${l.name}`], ['Account', l.account_name ? `${l.account_name} (${l.account_id})` : l.account_id],
  ['Targets', l.kind === 'pages' ? M.list(l.targets) : undefined], ['Prefix', l.prefix || '(none)'], ['service_role key', M.yes(l.service_key)], ['Database URL', M.yes(l.database_url)],
  ['Hyperdrive', l.hyperdrive ? (l.hyperdrive_id || 'yes') : 'no'], ['Variables', M.list(l.variables)], ['Token', l.token],
  ['Last sync', l.last_sync_at ? U.ago(l.last_sync_at) : null], l.last_error ? ['Error', U.c.red(l.last_error)] : null, ['ID', l.id]]);

async function onlyInstallation(ref, flags) {
  if (flags.installation) return Number(flags.installation);
  const s = await api.get(`/projects/${ref}/integrations/github`);
  if (s.link && !flags.any) return s.link.installation_id;
  if (s.installations?.length === 1) return s.installations[0].installation_id;
  if (!s.installations?.length) U.fail('The StitchDB GitHub App is not installed for this organization yet.', { hint: s.install_url ? `Install it: ${s.install_url}` : 'Install it from the dashboard: Project → Integrations → GitHub.' });
  U.fail('More than one GitHub installation: pass --installation <id>.', { hint: s.installations.map((i) => `  ${i.installation_id}  ${i.account}`).join('\n') });
}

module.exports = {
  // ----- custom domains -----
  'domains list': {
    group: 'Integrations', summary: 'Custom domains of a project and their status',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.get(`/projects/${ref}/custom-domains`);
      U.output(r, () => {
        U.log(`CNAME target ${U.c.bold(r.target)}, ${r.domains?.length || 0} of ${r.limit || 0} domain(s) on your plan.`);
        U.table(['DOMAIN', 'STATUS', 'AUTH', 'STATUS PAGE', 'CERTIFICATE', 'ERROR'], (r.domains || []).map((d) => [d.domain, DSTATUS[d.status] || d.status, d.use_for_auth ? 'yes' : '', d.use_for_status ? 'yes' : '',
          d.cert_expires_at ? `until ${M.date(d.cert_expires_at).slice(0, 10)}` : '', d.error || '']));
      });
      return r;
    },
  },
  'domains get': {
    group: 'Integrations', summary: 'One custom domain: status, certificate and the DNS records to add',
    usage: '[ref] <domain>',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const d = await api.get(dpath(ref, domainArg(args)));
      U.output(d, () => {
        M.fields([['Domain', d.domain], ['Status', DSTATUS[d.status] || d.status], ['URL', d.url], ['Used for Auth', M.yes(d.use_for_auth)], ['Used for status page', M.yes(d.use_for_status)],
          ['Certificate until', M.date(d.cert_expires_at)], ['Checked', d.checked_at ? U.ago(d.checked_at) : null], d.error ? ['Error', U.c.red(d.error)] : null]);
        U.log('');
        U.table(['TYPE', 'NAME', 'VALUE', 'NEEDED'], (d.dns_records || []).map((x) => [x.type, x.name, x.value, x.needed]));
      });
      return d;
    },
  },
  'domains add': {
    group: 'Integrations', summary: 'Add a custom domain (paid plans): DNS check and certificate',
    usage: '[ref] <domain>',
    examples: 'stitchdb domains add api.example.com',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const d = domainArg(args);
      const r = await api.post(`/projects/${ref}/custom-domains`, { domain: d });
      U.output(r, () => {
        const mine = r?.domains?.find((x) => x.domain === d);
        U.ok(`Added ${d}${mine ? ` (${mine.status})` : ''}.`);
        if (mine?.status !== 'active') dnsHelp(r?.target || 'your project host (see "stitchdb domains get")', d);
      });
      return r;
    },
  },
  'domains check': {
    group: 'Integrations', summary: 'Check DNS and the certificate of a domain now',
    usage: '[ref] <domain>',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const d = domainArg(args);
      const r = await api.post(`${dpath(ref, d)}/check`, {});
      U.output(r, () => {
        const x = r?.domains ? r.domains.find((y) => y.domain === d) : r;
        if (x?.status === 'active') U.ok(`${d} is live.`);
        else U.log(`${d}: ${DSTATUS[x?.status] || x?.status || 'checked'}${x?.error ? ' — ' + x.error : ''}`);
      });
      return r;
    },
  },
  'domains update': {
    group: 'Integrations', summary: 'Use a live domain for Auth links / the status page',
    usage: '[ref] <domain> [--use-for-auth | --no-use-for-auth] [--use-for-status | --no-use-for-status]',
    description: 'Using a domain for Auth rewrites e-mail links and OAuth callbacks to it and restarts Auth (needs a credential that may change Auth settings).',
    flags: { useForAuth: { type: 'boolean' }, useForStatus: { type: 'boolean' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const d = domainArg(args);
      const body = {};
      if (flags.useForAuth !== undefined) body.use_for_auth = flags.useForAuth;
      if (flags.useForStatus !== undefined) body.use_for_status = flags.useForStatus;
      if (!Object.keys(body).length) U.fail('Pass --use-for-auth / --no-use-for-auth or --use-for-status / --no-use-for-status.');
      const r = await api.request('PUT', dpath(ref, d), { body });
      U.ok(`Updated ${d}.`);
      return r;
    },
  },
  'domains remove': {
    group: 'Integrations', summary: 'Remove a custom domain (stops serving it)',
    usage: '[ref] <domain> [--yes]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const d = domainArg(args);
      await M.confirm(flags, `Remove ${d} from ${ref}? Requests to it stop working.`);
      const r = await api.del(dpath(ref, d));
      U.ok(`Removed ${d}.`);
      return r;
    },
  },

  // ----- Vercel -----
  'vercel list': {
    group: 'Integrations', summary: 'Vercel projects linked to this project (environment variable sync)',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const r = await api.get(`/projects/${ref}/integrations/vercel`);
      U.output(r, () => U.table(['ID', 'VERCEL PROJECT', 'TARGETS', 'PREFIX', 'LAST SYNC', 'ERROR'], (r.links || []).map((l) => [l.id, l.vercel_project_name, M.list(l.targets), l.prefix || '(none)', l.last_sync_at ? U.ago(l.last_sync_at) : '', l.last_error ? U.c.red(l.last_error) : ''])));
      return r;
    },
  },
  'vercel browse': {
    group: 'Integrations', summary: 'Teams and projects a Vercel token can reach',
    usage: '[ref] [--token <token>] [--team <id>]',
    options: `--token <token>   Vercel access token (or VERCEL_TOKEN)
--team <id>       List the projects of this team`,
    flags: { token: { type: 'string' }, team: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const r = await api.post(`/projects/${ref}/integrations/vercel/browse`, { token: await vercelToken(flags), team_id: flags.team });
      U.output(r, () => {
        if (r.teams?.length) { U.log(U.c.bold('Teams')); U.table(['ID', 'NAME'], r.teams.map((t) => [t.id, t.name])); U.log(''); }
        U.log(U.c.bold(`Projects${flags.team ? ` of ${flags.team}` : ''}`));
        U.table(['ID', 'NAME', 'FRAMEWORK'], (r.projects || []).map((p) => [p.id, p.name, p.framework || '']));
      });
      return r;
    },
  },
  'vercel link': {
    group: 'Integrations', summary: 'Link a Vercel project and write its environment variables',
    usage: '[ref] <vercel project id|name> [--token <token>] [--team <id>] [--targets production,preview] [--prefix NEXT_PUBLIC_]',
    description: `Writes the API URL and anon key (optionally the service_role key and the database URLs) into the Vercel project and keeps them
up to date when keys rotate. The token is stored encrypted on StitchDB.`,
    options: `--token <token>      Vercel access token (or VERCEL_TOKEN)
--team <id>          Vercel team that owns the project
--targets <list>     production, preview, development (default production,preview)
--prefix <prefix>    NEXT_PUBLIC_ (default), VITE_, PUBLIC_, EXPO_PUBLIC_, NUXT_PUBLIC_, REACT_APP_ or none
--service-key        Also write the service_role key (server-side variable)
--database-url       Also write the Postgres connection strings`,
    examples: 'stitchdb vercel link my-next-app --prefix NEXT_PUBLIC_ --targets production,preview',
    flags: VERCEL_FLAGS,
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      if (!args[0]) U.fail('Give the Vercel project id or name.', { hint: 'List them with "stitchdb vercel browse".' });
      const r = await api.post(`/projects/${ref}/integrations/vercel`, { token: await vercelToken(flags), team_id: flags.team, vercel_project_id: args[0], ...vercelOptions(flags) });
      U.output(r, () => { U.ok(`Linked ${r.vercel_project_name} and wrote ${r.variables?.length || 0} variable(s).`); showVercel(r); });
      return r;
    },
  },
  'vercel update': {
    group: 'Integrations', summary: 'Change a Vercel link (targets, prefix, variables, token) and sync',
    usage: '[ref] <link id|vercel project> [--targets <list>] [--prefix <p>] [--service-key | --no-service-key] [--database-url | --no-database-url] [--token <t>]',
    flags: VERCEL_FLAGS,
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const l = await vercelLink(ref, args[0]);
      const body = vercelOptions(flags);
      const token = await vercelToken(flags, { required: false });
      if (token) body.token = token;
      if (!Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --targets, --prefix, --service-key, --database-url or --token.' });
      const r = await api.patch(`/projects/${ref}/integrations/vercel/${l.id}`, body);
      U.output(r, () => { U.ok(`Updated ${r.vercel_project_name}.`); showVercel(r); });
      return r;
    },
  },
  'vercel sync': {
    group: 'Integrations', summary: 'Write the environment variables to Vercel again now',
    usage: '[ref] <link id|vercel project>',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const l = await vercelLink(ref, args[0]);
      const r = await api.post(`/projects/${ref}/integrations/vercel/${l.id}/sync`, {});
      U.ok(`Synced ${r.vercel_project_name || l.vercel_project_name}: ${M.list(r.variables)}`);
      return r;
    },
  },
  'vercel unlink': {
    group: 'Integrations', summary: 'Unlink a Vercel project',
    usage: '[ref] <link id|vercel project> [--remove-variables] [--yes]',
    options: '--remove-variables   Also delete the variables StitchDB wrote in Vercel',
    flags: { removeVariables: { type: 'boolean' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const l = await vercelLink(ref, args[0]);
      await M.confirm(flags, `Unlink ${l.vercel_project_name}${flags.removeVariables ? ' and delete its StitchDB variables in Vercel' : ''}?`);
      const r = await api.del(`/projects/${ref}/integrations/vercel/${l.id}`, { query: { remove_variables: flags.removeVariables ? 'true' : undefined } });
      U.ok(`Unlinked ${l.vercel_project_name}.`);
      return r;
    },
  },

  // ----- Cloudflare -----
  'cloudflare list': {
    group: 'Integrations', summary: 'Cloudflare Workers and Pages projects linked to this project (variable sync)',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const r = await api.get(`/projects/${ref}/integrations/cloudflare`);
      U.output(r, () => U.table(['ID', 'KIND', 'NAME', 'ACCOUNT', 'PREFIX', 'LAST SYNC', 'ERROR'], (r.links || []).map((l) => [l.id, l.kind, l.name, l.account_name || l.account_id, l.prefix || '(none)',
        l.last_sync_at ? U.ago(l.last_sync_at) : '', l.last_error ? U.c.red(l.last_error) : ''])));
      return r;
    },
  },
  'cloudflare browse': {
    group: 'Integrations', summary: 'Accounts, Workers and Pages projects a Cloudflare token can reach',
    usage: '[ref] [--token <token>] [--account <id>]',
    options: `--token <token>   Cloudflare API token (or CLOUDFLARE_API_TOKEN)
--account <id>    List the Workers and Pages projects of this account (default: the first one)`,
    flags: { token: { type: 'string' }, account: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const r = await api.post(`/projects/${ref}/integrations/cloudflare/browse`, { token: await cfToken(flags), account_id: flags.account });
      U.output(r, () => {
        U.log(U.c.bold('Accounts')); U.table(['ID', 'NAME'], (r.accounts || []).map((a) => [a.id, a.id === r.account_id ? `${a.name} ${U.c.dim('(listed below)')}` : a.name]));
        U.log(`\n${U.c.bold('Workers')}`); if (r.workers_error) U.log(U.c.yellow(`  ${r.workers_error}`)); else U.table(['NAME'], (r.workers || []).map((w) => [w.name]));
        U.log(`\n${U.c.bold('Pages projects')}`); if (r.pages_error) U.log(U.c.yellow(`  ${r.pages_error}`)); else U.table(['NAME'], (r.pages || []).map((p) => [p.name]));
      });
      return r;
    },
  },
  'cloudflare link': {
    group: 'Integrations', summary: 'Link a Cloudflare Worker or Pages project and write its variables',
    usage: '[ref] <worker|pages project name> [--kind worker|pages] [--account <id>] [--token <token>] [--targets production,preview] [--prefix VITE_]',
    description: `Writes the API URL and anon key (optionally the service_role key, the database URLs or a Hyperdrive config) into the
Worker's secrets or the Pages project's environment variables, and keeps them up to date when keys rotate. The token is
stored encrypted on StitchDB. Without --account / --kind the token's only account is used and the kind is looked up.`,
    options: `--token <token>      Cloudflare API token (or CLOUDFLARE_API_TOKEN): Workers Scripts: Edit and/or Cloudflare Pages: Edit
--account <id>       Cloudflare account id (default: the token's only account)
--kind <kind>        worker or pages (default: found by name)
--targets <list>     Pages only: production, preview (default both)
--prefix <prefix>    VITE_, NEXT_PUBLIC_, PUBLIC_, EXPO_PUBLIC_, NUXT_PUBLIC_, REACT_APP_ or none (default none)
--service-key        Also write the service_role key
--database-url       Also write the Postgres connection strings
--hyperdrive         Create a Hyperdrive config for the database and bind it`,
    examples: `stitchdb cloudflare link my-worker --service-key
stitchdb cloudflare link my-site --kind pages --prefix VITE_ --targets production,preview`,
    flags: CF_FLAGS,
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const name = args[0];
      if (!name) U.fail('Give the Worker or Pages project name.', { hint: 'List them with "stitchdb cloudflare browse".' });
      if (flags.kind && !['worker', 'pages'].includes(flags.kind)) U.fail('--kind is worker or pages.');
      const token = await cfToken(flags);
      let account = flags.account, kind = flags.kind;
      if (!account || !kind) {
        const b = await api.post(`/projects/${ref}/integrations/cloudflare/browse`, { token, account_id: account });
        if (!account) {
          if ((b.accounts || []).length > 1) U.fail('The token reaches more than one Cloudflare account: pass --account <id>.', { hint: b.accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n') });
          account = b.account_id || b.accounts?.[0]?.id;
          if (!account) U.fail('The token cannot see any Cloudflare account.');
        }
        if (!kind) {
          const w = (b.workers || []).some((x) => x.name === name), p = (b.pages || []).some((x) => x.name === name);
          if (w && p) U.fail(`${name} is both a Worker and a Pages project: pass --kind worker or --kind pages.`);
          if (!w && !p) U.fail(`No Worker or Pages project named ${name} in this account.`, { hint: 'List them with "stitchdb cloudflare browse".' });
          kind = w ? 'worker' : 'pages';
        }
      }
      const r = await api.post(`/projects/${ref}/integrations/cloudflare`, { token, account_id: account, kind, name, ...cfOptions(flags) });
      U.output(r, () => { U.ok(`Linked ${r.kind === 'pages' ? 'Pages project' : 'Worker'} ${r.name} and wrote ${r.variables?.length || 0} variable(s).`); showCf(r); });
      return r;
    },
  },
  'cloudflare update': {
    group: 'Integrations', summary: 'Change a Cloudflare link (targets, prefix, variables, token) and sync',
    usage: '[ref] <link id|name> [--targets <list>] [--prefix <p>] [--service-key | --no-service-key] [--database-url | --no-database-url] [--hyperdrive | --no-hyperdrive] [--token <t>]',
    flags: CF_FLAGS,
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const l = await cfLink(ref, args[0]);
      const body = cfOptions(flags);
      const token = await cfToken(flags, { required: false });
      if (token) body.token = token;
      if (!Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --targets, --prefix, --service-key, --database-url, --hyperdrive or --token.' });
      const r = await api.patch(`/projects/${ref}/integrations/cloudflare/${l.id}`, body);
      U.output(r, () => { U.ok(`Updated ${r.name}.`); showCf(r); });
      return r;
    },
  },
  'cloudflare sync': {
    group: 'Integrations', summary: 'Write the variables to Cloudflare again now',
    usage: '[ref] <link id|name>',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const l = await cfLink(ref, args[0]);
      const r = await api.post(`/projects/${ref}/integrations/cloudflare/${l.id}/sync`, {});
      U.ok(`Synced ${r.name || l.name}: ${M.list(r.variables)}`);
      return r;
    },
  },
  'cloudflare unlink': {
    group: 'Integrations', summary: 'Unlink a Cloudflare Worker or Pages project',
    usage: '[ref] <link id|name> [--remove-variables] [--yes]',
    options: '--remove-variables   Also delete the variables (and Hyperdrive config) StitchDB wrote in Cloudflare',
    flags: { removeVariables: { type: 'boolean' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const l = await cfLink(ref, args[0]);
      await M.confirm(flags, `Unlink ${l.name}${flags.removeVariables ? ' and delete its StitchDB variables in Cloudflare' : ''}?`);
      const r = await api.del(`/projects/${ref}/integrations/cloudflare/${l.id}`, { query: { remove_variables: flags.removeVariables ? 'true' : undefined } });
      U.ok(`Unlinked ${l.name}.`);
      return r;
    },
  },

  // ----- GitHub App -----
  'github status': {
    group: 'Integrations', summary: 'GitHub App: linked repository, installations and recent runs',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const s = await api.get(`/projects/${ref}/integrations/github`);
      U.output(s, () => {
        if (s.link) M.fields([['Repository', s.link.repository], ['Production branch', s.link.production_branch], ['Folder', s.link.dir || '(root)'],
          ['Deploy production', M.yes(s.link.deploy_production)], ['Branch data', s.link.branch_data], ['Installation', s.link.installation_id]]);
        else U.log('No repository linked.');
        if (s.installations?.length) { U.log(`\n${U.c.bold('Installations')}`); U.table(['ID', 'ACCOUNT', 'TYPE'], s.installations.map((i) => [i.installation_id, i.account, i.account_type])); }
        else if (s.install_url) U.log(`\nInstall the GitHub App: ${s.install_url}`);
        if (s.runs?.length) { U.log(`\n${U.c.bold('Recent runs')}`); U.table(['KIND', 'PR', 'BRANCH', 'STATUS', 'WHEN'], s.runs.slice(0, 10).map((r) => [r.kind, r.pr_number ? '#' + r.pr_number : '', r.git_branch || '', r.status, U.ago(r.created_at)])); }
      });
      return s;
    },
  },
  'github repos': {
    group: 'Integrations', summary: 'Repositories a GitHub App installation can reach',
    usage: '[ref] [--installation <id>]',
    flags: { installation: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const iid = await onlyInstallation(ref, { ...flags, any: true });
      const r = await api.get(`/projects/${ref}/integrations/github/repositories`, { query: { installation_id: iid } });
      U.output(r, () => U.table(['ID', 'REPOSITORY', 'DEFAULT BRANCH', 'PRIVATE'], (r.repositories || []).map((x) => [x.id, x.full_name, x.default_branch, x.private ? 'yes' : ''])));
      return r;
    },
  },
  'github link': {
    group: 'Integrations', summary: 'Link a repository: a preview branch per pull request',
    usage: '[ref] <owner/repo|repo id> [--installation <id>] [--production-branch main] [--dir stitchdb] [--deploy-production] [--branch-data masked]',
    description: 'Each pull request gets a preview branch with its migrations; merging applies them to production when --deploy-production is set.',
    options: `--installation <id>        GitHub App installation (default: the only one)
--production-branch <name> Branch that is production (default: the repository's default branch)
--dir <folder>             Folder with config.toml and migrations/ (default stitchdb)
--deploy-production        Apply migrations to production on push to the production branch
--branch-data <none|masked> Copy masked data into preview branches`,
    flags: { installation: { type: 'string' }, productionBranch: { type: 'string' }, dir: { type: 'string' }, deployProduction: { type: 'boolean' }, branchData: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const want = args[0];
      if (!want) U.fail('Give the repository (owner/name).', { hint: 'List them with "stitchdb github repos".' });
      const iid = await onlyInstallation(ref, { ...flags, any: true });
      let repoId = /^\d+$/.test(want) ? Number(want) : null;
      if (!repoId) {
        const { repositories = [] } = await api.get(`/projects/${ref}/integrations/github/repositories`, { query: { installation_id: iid } });
        const hit = repositories.find((x) => x.full_name.toLowerCase() === want.toLowerCase());
        if (!hit) U.fail(`The GitHub App cannot see ${want}.`, { hint: 'Add the repository to the installation on GitHub, or check "stitchdb github repos".' });
        repoId = hit.id;
      }
      if (flags.branchData && !['none', 'masked'].includes(flags.branchData)) U.fail('--branch-data is none or masked.');
      const body = { installation_id: iid, repo_id: repoId, production_branch: flags.productionBranch, dir: flags.dir, deploy_production: !!flags.deployProduction, branch_data: flags.branchData };
      const r = await api.request('PUT', `/projects/${ref}/integrations/github`, { body });
      U.output(r, () => U.ok(`Linked ${r.repository} (production branch ${r.production_branch}, folder ${r.dir || '(root)'}).`));
      return r;
    },
  },
  'github unlink': {
    group: 'Integrations', summary: 'Unlink the repository (existing branches stay)',
    usage: '[ref] [--yes]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      await M.confirm(flags, `Unlink the GitHub repository from ${ref}? Pull requests stop creating preview branches.`);
      const r = await api.del(`/projects/${ref}/integrations/github`);
      U.ok('Unlinked the repository.');
      return r;
    },
  },
};
