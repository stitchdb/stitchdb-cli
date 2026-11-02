// auth config get|update, graphql status|enable|disable, network-restrictions get|set, branches masking get|set|preview
'use strict';
const U = require('../util');
const api = require('../api');
const M = require('../manage');

// "a.b.c=value" -> { a: { b: { c: value } } } merged into obj.
function setPath(obj, key, val) {
  const parts = key.split('.');
  if (parts.some((p) => !p || p === '__proto__' || p === 'constructor' || p === 'prototype')) U.fail(`"${key}" is not a setting name.`);
  let o = obj;
  for (const p of parts.slice(0, -1)) { if (typeof o[p] !== 'object' || o[p] === null) o[p] = {}; o = o[p]; }
  o[parts.at(-1)] = val;
  return obj;
}

function showAuth(c) {
  const providers = Object.entries(c.providers || {}).filter(([, v]) => v.enabled).map(([k]) => k);
  M.fields([['Site URL', c.site_url], ['Redirect URLs', M.list(c.uri_allow_list)], ['Sign-ups', c.disable_signup ? U.c.yellow('disabled') : 'allowed'],
    ['E-mail sign-in', M.yes(c.email_enabled)], ['Auto-confirm e-mail', M.yes(c.mailer_autoconfirm)], ['Anonymous users', M.yes(c.anonymous_users)],
    ['JWT expiry', c.jwt_exp != null ? `${c.jwt_exp}s` : undefined], ['Min password length', c.password_min_length], ['OAuth providers', providers.join(', ')],
    ['SMTP', c.smtp ? `${c.smtp.host}:${c.smtp.port} (${c.smtp.admin_email})` : 'built-in'], ['Callback URL', c.meta?.callback_url]]);
  U.log(U.c.dim('  Everything (templates, rate limits, hooks, MFA, SMS): --json'));
}

const AUTH_BOOL = { signup: ['disable_signup', true], emailSignin: ['email_enabled', false], autoconfirm: ['mailer_autoconfirm', false], anonymous: ['anonymous_users', false] };

module.exports = {
  'auth config get': {
    group: 'Project settings', summary: 'Show the Auth settings of a project',
    usage: '[ref]',
    description: 'Secrets (provider secrets, SMTP password, hook secrets) are never returned, only whether they are set.',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const c = await api.get(`/projects/${ref}/config/auth`);
      U.output(c, showAuth);
      return c;
    },
  },
  'auth config update': {
    group: 'Project settings', summary: 'Change Auth settings (site URL, redirect URLs, sign-ups, providers, SMTP, …)',
    usage: '[ref] [--site-url <url>] [--redirect-url <url>]... [--set key=value]... [--file settings.json]',
    description: `Only the given settings change. Auth restarts to apply them (a few seconds).
--set takes any setting of "stitchdb auth config get --json"; dots reach nested ones (providers.github.enabled=true).
Values are JSON when they look like it (true, 3600, ["a","b"], {"k":1}), else text.`,
    options: `--site-url <url>          Where e-mail links send users back to
--redirect-url <url>      Allowed redirect URL, repeatable (replaces the list)
--no-signup / --signup    Turn new sign-ups off / on
--autoconfirm             Sign users in without e-mail confirmation (--no-autoconfirm to require it)
--anonymous               Allow anonymous sign-ins (--no-anonymous to refuse)
--no-email-signin         Turn e-mail and password sign-in off (--email-signin on)
--set <key=value>         Any setting, repeatable
--file <json>             Settings from a JSON file (flags win)`,
    examples: `stitchdb auth config update --site-url https://app.example.com --redirect-url https://app.example.com/** --redirect-url http://localhost:3000/**
stitchdb auth config update --set providers.github.enabled=true --set providers.github.client_id=abc --set providers.github.secret=xyz
stitchdb auth config update --file auth.json`,
    flags: { siteUrl: { type: 'string' }, redirectUrl: { type: 'array' }, signup: { type: 'boolean' }, autoconfirm: { type: 'boolean' }, anonymous: { type: 'boolean' },
      emailSignin: { type: 'boolean' }, set: { type: 'array' }, file: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const body = flags.file ? M.readJson(flags.file) : {};
      if (typeof body !== 'object' || Array.isArray(body) || body === null) U.fail(`${flags.file} must hold a JSON object.`);
      if (flags.siteUrl !== undefined) body.site_url = flags.siteUrl;
      if (flags.redirectUrl) body.uri_allow_list = flags.redirectUrl;
      for (const [flag, [key, invert]] of Object.entries(AUTH_BOOL)) if (flags[flag] !== undefined) body[key] = invert ? !flags[flag] : flags[flag];
      // --set values may contain commas (JSON lists): the array flag split them, so join the pieces back.
      const sets = [];
      for (const s of flags.set || []) { if (sets.length && !/^[A-Za-z0-9_.]+=/.test(s)) sets[sets.length - 1] += ',' + s; else sets.push(s); }
      for (const s of sets) { const i = s.indexOf('='); if (i <= 0) U.fail(`"${s}" is not key=value.`); setPath(body, s.slice(0, i).trim(), M.value(s.slice(i + 1).trim())); }
      if (!Object.keys(body).length) U.fail('Nothing to change.', { hint: 'Pass --site-url, --redirect-url, --set key=value or --file.' });
      const r = await api.patch(`/projects/${ref}/config/auth`, body);
      U.output(r, () => { U.ok(`Saved ${Object.keys(body).join(', ')}${r.restarted ? ' (Auth restarted)' : ''}.`); showAuth(r); });
      return r;
    },
  },

  'graphql status': {
    group: 'Project settings', summary: 'Is the GraphQL API on, and its URL',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.get(`/projects/${ref}/graphql`);
      U.output(r, () => M.fields([['GraphQL API', r.enabled ? U.c.green('on') : 'off'], ['URL', r.url]]));
      return r;
    },
  },
  'graphql enable': {
    group: 'Project settings', summary: 'Turn the GraphQL API (/graphql/v1) on',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.request('PUT', `/projects/${ref}/graphql`, { body: { enabled: true } });
      U.ok(`GraphQL API on: ${r.url}`);
      return r;
    },
  },
  'graphql disable': {
    group: 'Project settings', summary: 'Turn the GraphQL API off',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.request('PUT', `/projects/${ref}/graphql`, { body: { enabled: false } });
      U.ok('GraphQL API off.');
      return r;
    },
  },

  'network-restrictions get': {
    group: 'Project settings', summary: 'Addresses allowed to connect to Postgres from outside',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.get(`/projects/${ref}/network-restrictions`);
      U.output(r, () => {
        if (!r.allowlist) U.log('Every address may connect (no restriction).');
        else { U.log(`Allowed (${r.allowlist.length} of at most ${r.max}):`); for (const a of r.allowlist) U.log(`  ${a}`); }
        if (r.your_ip) U.log(U.c.dim(`  Your address: ${r.your_ip}`));
      });
      return r;
    },
  },
  'network-restrictions set': {
    group: 'Project settings', summary: 'Limit Postgres connections to IPv4 addresses or ranges',
    usage: '[ref] <address|range>... | --add <list> | --remove <list> | --all [--yes]',
    description: `Applies to direct and pooled Postgres connections from outside (the REST API, Auth and Studio are not affected).
Up to 50 entries; open connections stay open. --all removes the restriction.`,
    options: `--add <list>      Add these to the current list
--remove <list>   Remove these from the current list
--all             Allow every address again`,
    examples: 'stitchdb network-restrictions set 203.0.113.7 198.51.100.0/24\nstitchdb network-restrictions set --add 192.0.2.10\nstitchdb network-restrictions set --all',
    flags: { add: { type: 'array' }, remove: { type: 'array' }, all: { type: 'boolean' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      let next;
      if (flags.all) next = null;
      else if (flags.add || flags.remove) {
        const cur = (await api.get(`/projects/${ref}/network-restrictions`)).allowlist || [];
        const drop = new Set(flags.remove || []);
        next = [...new Set([...cur, ...(flags.add || []), ...args])].filter((a) => !drop.has(a));
        if (!next.length) next = null;
      } else if (args.length) next = [...new Set(args.flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean))];
      else U.fail('Give the allowed addresses, --add / --remove, or --all.');
      if (next) await M.confirm(flags, `Only ${next.join(', ')} may connect to the Postgres of ${ref} from outside. Continue?`);
      const r = await api.request('PUT', `/projects/${ref}/network-restrictions`, { body: { allowlist: next } });
      U.output(r, () => U.ok(r.allowlist ? `Allowed: ${r.allowlist.join(', ')}` : 'Every address may connect.'));
      return r;
    },
  },

  'branches masking get': {
    group: 'Preview branches', summary: 'Masking rules for data copied into branches and new projects',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const r = await api.get(`/projects/${ref}/branches/masking`);
      U.output(r, () => U.table(['COLUMN', 'STRATEGY'], Object.entries(r.rules || {}).map(([k, v]) => [k, v])));
      return r;
    },
  },
  'branches masking set': {
    group: 'Preview branches', summary: 'Set masking rules (schema.table.column=strategy)',
    usage: '[ref] <schema.table.column=strategy>... [--remove <column>] [--replace] [--file rules.json]',
    description: `Rules are merged into the current ones unless --replace. Auth tables are always masked.
Strategies: email, first_name, last_name, full_name, username, phone, street, city, zip, ip, date, text, hash, digits, empty, null, keep.`,
    options: `--remove <list>   Drop the rules of these columns
--replace         Replace every rule with the given ones
--file <json>     Rules from a JSON file ({ "rules": { "public.users.email": "email" } } or the map itself)`,
    examples: 'stitchdb branches masking set public.customers.email=email public.customers.phone=phone\nstitchdb branches masking set --remove public.customers.phone',
    flags: { remove: { type: 'array' }, replace: { type: 'boolean' }, file: { type: 'string' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const given = {};
      if (flags.file) { const f = M.readJson(flags.file); Object.assign(given, f.rules && typeof f.rules === 'object' ? f.rules : f); }
      for (const a of args) { const i = a.indexOf('='); if (i <= 0) U.fail(`"${a}" is not schema.table.column=strategy.`); given[a.slice(0, i).trim()] = a.slice(i + 1).trim(); }
      if (!Object.keys(given).length && !flags.remove && !flags.replace) U.fail('Give at least one rule, like public.users.email=email.');
      const rules = flags.replace ? {} : { ...((await api.get(`/projects/${ref}/branches/masking`)).rules || {}) };
      Object.assign(rules, given);
      for (const k of flags.remove || []) delete rules[k];
      if (flags.replace) await M.confirm(flags, `Replace every masking rule of ${ref} with ${Object.keys(rules).length} rule(s)?`);
      const r = await api.request('PUT', `/projects/${ref}/branches/masking`, { body: { rules } });
      U.output(r, () => { U.ok(`Saved ${Object.keys(r.rules || {}).length} masking rule(s).`); U.table(['COLUMN', 'STRATEGY'], Object.entries(r.rules || {})); });
      return r;
    },
  },
  'branches masking preview': {
    group: 'Preview branches', summary: 'What a masked copy would copy and mask',
    usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args, { allowBranch: false });
      const r = await api.get(`/projects/${ref}/branches/masking/preview`);
      U.output(r, () => {
        U.table(['TABLE', 'ROWS', 'SIZE', 'MASKED'], (r.tables || []).map((t) => [`${t.schema}.${t.table}`, M.num(t.rows), M.bytes(t.bytes),
          (t.masked || []).map((m) => (typeof m === 'string' ? m : `${m.column}→${m.strategy}`)).join(', ')]));
        U.log(`  Total ${M.bytes(r.bytes)} of ${r.limit_mb} MB allowed${r.over_limit ? U.c.yellow(' (over the limit: pick tables when copying)') : ''}.`);
      });
      return r;
    },
  },
  _internal: { setPath },
};
