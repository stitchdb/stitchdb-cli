// The rest of the dashboard on the Management API: database objects and rows, Vault, SQL history and snippets,
// database roles, SQL over HTTP, test data, Auth users / e-mail / SMTP / providers / organizations / sign-up
// protection, the hosted sign-in page, Storage and S3 keys, Stripe sync, realtime history, search, background jobs,
// analytics, offline sync, collaboration, SQL reports and health alerts; account-level billing, support, own servers,
// dedicated servers, the AI assistant and typed clients; and "stitchdb api" for any Management API operation.
// Secrets (SMTP password, provider secrets, API keys, passwords) are read from --secret-file, --secret-stdin or a
// hidden prompt, so they never sit in shell history; the API never returns them.
'use strict';
const fs = require('fs');
const U = require('../util');
const M = require('../manage');
const api = require('../api');
const F = require('../feature-cmd');
const { input, needBody, need, enc, tableArg, show } = F;

const FILE_OPT = `--file <json>         Fields from a JSON file (key=value arguments win)
key=value             A field; dots reach nested ones; values are JSON when they look like it`;
const SECRET_OPT = `--secret-file <file>  Read the secret from a file
--secret-stdin        Read the secret from standard input (else it is asked for, hidden)`;
const FLAGS = { file: { type: 'string', alias: 'f' }, set: { type: 'array' }, secretFile: { type: 'string' }, secretStdin: { type: 'boolean' }, out: { type: 'string', alias: 'o' } };
const SCHEMA_PARAMS = new Set(['table', 'index', 'view_name', 'trigger', 'policy']);

function getPath(o, key) { return key.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o); }
// The secret of a command: --secret-file, --secret-stdin, else a hidden prompt (required: on a terminal, or fails;
// prompt: on a terminal, empty = none; otherwise none).
async function secretOf(flags, label, { required = false, prompt = false } = {}) {
  if (flags.secretFile) return M.readText(flags.secretFile).trim() || undefined;
  if (flags.secretStdin) return fs.readFileSync(0, 'utf8').trim() || undefined;
  if (!required && !(prompt && process.stdin.isTTY)) return undefined;
  if (!process.stdin.isTTY) U.fail(`${label} is required.`, { hint: 'Pass --secret-file <file> or --secret-stdin.' });
  const v = await U.ask(`${label}:`, { hidden: true });
  return required ? need(v, `${label} is required.`) : v || undefined;
}
async function addSecret(flags, body, s) {
  if (!s || getPath(body, s.field) !== undefined) return body;
  const v = await secretOf(flags, s.label || 'Secret', { required: !!s.required, prompt: !!s.prompt });
  if (v !== undefined) F.setPath(body, s.field, v);
  return body;
}
function request(method, path, { body, query, raw } = {}) {
  if (raw) return api.request(method, path, { query, raw: true });
  return api.request(method, path, { body: method === 'GET' || (method === 'DELETE' && body && !Object.keys(body).length) ? undefined : body ?? {}, query });
}
// A file answer (CSV export, attachment): to --out or standard output.
async function saveRaw(res, flags) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (flags.out) { fs.writeFileSync(flags.out, buf); U.ok(`Saved ${M.bytes(buf.length)} to ${flags.out}.`); } else process.stdout.write(buf);
}

// [name, method, path, summary, o]: {param} placeholders are filled from positionals in order (a table may be given as
// schema.table); key=value pairs go to the query string for GET (and o.q), else to the body. o: { confirm, secret:
// { field, label, required }, body(c) (a custom body), raw (a file answer), usage, examples, description, q, bodyDelete }.
function make(group, [name, method, path, summary, o = {}]) {
  const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const usage = o.usage || ['[ref]', ...params.map((p) => `<${p.replace(/_/g, ' ')}>`), method === 'GET' ? '[key=value]...' : '[key=value]... [--file <json>]'].join(' ');
  return [name, {
    group, summary, usage, description: o.description, examples: o.examples,
    options: [o.options, method === 'GET' ? null : FILE_OPT, o.secret ? SECRET_OPT : null, o.raw ? '--out <file>          Save to a file (else standard output)' : null].filter(Boolean).join('\n') || undefined,
    flags: { ...FLAGS, ...(o.flags || {}) },
    async run({ flags, args }) {
      const pos = args.filter((a) => !/^[A-Za-z_][\w.]*=/.test(a));
      // A leading ref only beyond the positionals the command needs (account commands take none).
      const ref = o.account ? null : F.refOf(flags, pos, params.length + (o.need || 0));
      const query = {};
      let tail = path;
      params.forEach((p, i) => {
        let v = need(pos[i], `Give the ${p.replace(/_/g, ' ')}.`);
        if (SCHEMA_PARAMS.has(p) && v.includes('.')) { const t = tableArg(v); query.schema = t.schema; v = t.table; }
        tail = tail.replace(`{${p}}`, enc(v));
      });
      const c = { flags, args: pos.slice(params.length), ref, query };
      let body = input(flags, args.filter((a) => /^[A-Za-z_][\w.]*=/.test(a)));
      if (o.body) body = await o.body(c, body);
      if (method === 'GET' || o.q) { Object.assign(query, body); body = undefined; }
      for (const k of o.qkeys || []) if (body && k in body) { query[k] = body[k]; delete body[k]; }
      for (const [k, v] of Object.entries(query)) if (v && typeof v === 'object') query[k] = JSON.stringify(v);
      if (body) await addSecret(flags, body, o.secret);
      if (o.confirm) await M.confirm(flags, typeof o.confirm === 'function' ? o.confirm(c) : o.confirm);
      const full = o.account ? tail : `/projects/${ref}${tail}`;
      if (o.raw) return saveRaw(await request(method, full, { query, raw: true }), flags);
      const r = await request(method, full, { body, query });
      U.output(r, () => { if (o.done) U.ok(o.done(r, c)); else if (r === null || r === undefined || (r && r.ok === true && Object.keys(r).length === 1)) U.ok('Done.'); else show(r); });
      return r;
    },
  }];
}
const group = (g, list) => list.map((d) => make(g, d));
const account = (g, list) => list.map(([n, m, p, s, o = {}]) => make(g, [n, m, p, s, { ...o, account: true, usage: o.usage || [...[...p.matchAll(/\{(\w+)\}/g)].map((x) => `<${x[1]}>`), m === 'GET' ? '[key=value]...' : '[key=value]... [--file <json>]'].join(' ') }]));

// "schema.table" -> { schema, table } in the body (rows, columns, policies, indexes, test data).
const tableBody = (c, b) => {
  const t = c.args[0] ? tableArg(c.args.shift()) : null;
  return t ? { schema: t.schema, table: t.table, ...b } : b;
};
const pkFlag = { pk: { type: 'string' } };
const pkOf = (flags) => { const v = M.value(need(flags.pk, 'Pass --pk with the primary key as JSON, like --pk \'{"id":1}\'.')); if (!v || typeof v !== 'object') U.fail('--pk is JSON, like \'{"id":1}\'.'); return v; };

const DB = 'Database', AU = 'Auth', ST = 'Storage';
const cmds = [
  ...group(DB, [
    ['db schemas', 'GET', '/database/schemas', 'Schemas shown in the dashboard (only public is editable)'],
    ['db tables', 'GET', '/database/tables', 'Tables of a schema with row estimates, size and RLS (schema=public)'],
    ['db columns', 'GET', '/database/columns', 'Columns of a table', { usage: '[ref] <schema.table>', body: tableBody, need: 1 }],
    ['db types', 'GET', '/database/types', 'Enum types in public and the column types to choose from'],
    ['db views', 'GET', '/database/views', 'Views and materialized views (schema=)'],
    ['db functions', 'GET', '/database/functions', 'Functions and procedures in public'],
    ['db triggers', 'GET', '/database/triggers', 'Triggers on public tables'],
    ['db indexes', 'GET', '/database/indexes', 'Indexes (schema= table=)'],
    ['db extensions', 'GET', '/database/extensions', 'Extensions: installed and available'],
    ['db publication', 'GET', '/database/publication', 'Tables in the realtime publication'],
    ['db policies', 'GET', '/database/policies', 'Row level security policies (schema= table=)'],
    ['db http-responses', 'GET', '/database/http-responses', 'Responses of pg_net HTTP requests'],
    ['db connections', 'GET', '/database/connections', 'Open database connections (long_query_s= idle_s=)'],
    ['db rows', 'GET', '/database/rows', 'Rows of a table (limit= offset= order=col.desc filter=[{"column","op","value"}])', { usage: '[ref] <schema.table> [limit=100] [offset=0] [order=col.asc|col.desc] [filter=<json>]', body: tableBody, need: 1 }],
    ['db rows export', 'GET', '/database/rows/export', 'A table as CSV (up to 10,000 rows)', { usage: '[ref] <schema.table> [order=] [filter=<json>] [--out file.csv]', body: tableBody, raw: true, need: 1 }],
    ['db rows insert', 'POST', '/database/rows', 'Insert a row', { usage: '[ref] <schema.table> col=value...', need: 1, examples: 'stitchdb db rows insert public.todos title="Buy milk" done=false',
      body: (c, b) => { const t = tableArg(need(c.args.shift(), 'Give the table.')); return { schema: t.schema, table: t.table, values: needBody(b.values || b) }; } }],
    ['db rows update', 'PATCH', '/database/rows', 'Update a row by its primary key', { usage: '[ref] <schema.table> --pk \'{"id":1}\' col=value...', flags: pkFlag, need: 1,
      body: (c, b) => { const t = tableArg(need(c.args.shift(), 'Give the table.')); return { schema: t.schema, table: t.table, pk: pkOf(c.flags), values: needBody(b.values || b) }; } }],
    ['db rows delete', 'DELETE', '/database/rows', 'Delete a row by its primary key', { usage: '[ref] <schema.table> --pk \'{"id":1}\'', flags: pkFlag, need: 1, confirm: 'Delete this row?',
      body: (c) => { const t = tableArg(need(c.args.shift(), 'Give the table.')); return { schema: t.schema, table: t.table, pks: [pkOf(c.flags)] }; } }],
    ['db tables create', 'POST', '/database/tables', 'Create a public table (name= columns=[{"name","type","is_pk","is_identity","nullable","default"}] rls=true realtime=)', { examples: 'stitchdb db tables create name=todos columns=\'[{"name":"id","type":"bigint","is_pk":true,"is_identity":true},{"name":"title","type":"text"}]\'' }],
    ['db tables update', 'PATCH', '/database/tables/{table}', 'Change a public table (new_name= comment= rls=true rls_forced= api_access= realtime=)'],
    ['db tables drop', 'DELETE', '/database/tables/{table}', 'Drop a public table (cascade=true)', { q: true, confirm: 'Drop this table and its data?' }],
    ['db columns add', 'POST', '/database/tables/{table}/columns', 'Add a column (name= type= nullable= default= unique= is_pk= fk= comment=)', { body: (c, b) => (c.query.schema ? { schema: c.query.schema, ...b } : b) }],
    ['db columns update', 'PATCH', '/database/tables/{table}/columns/{column}', 'Change a column (new_name= type= nullable= default= drop_default=true comment=)', { body: (c, b) => (c.query.schema ? { schema: c.query.schema, ...b } : b) }],
    ['db columns drop', 'DELETE', '/database/tables/{table}/columns/{column}', 'Drop a column (cascade=true)', { q: true, confirm: 'Drop this column and its data?' }],
    ['db indexes create', 'POST', '/database/indexes', 'Create an index in public (table= columns=["a"] unique=true method=btree|gin|gist|hash|brin)'],
    ['db indexes drop', 'DELETE', '/database/indexes/{index}', 'Drop an index (not the primary key)', { q: true, confirm: 'Drop this index?' }],
    ['db views drop', 'DELETE', '/database/views/{view_name}', 'Drop a view or materialized view', { q: true, confirm: 'Drop this view?' }],
    ['db functions drop', 'DELETE', '/database/functions/{oid}', 'Drop a function (its oid from "db functions")', { q: true, confirm: 'Drop this function?' }],
    ['db triggers enable', 'PATCH', '/database/triggers/{trigger}', 'Turn a trigger on (table=)', { body: (c, b) => ({ ...b, enabled: true }) }],
    ['db triggers disable', 'PATCH', '/database/triggers/{trigger}', 'Turn a trigger off (table=)', { body: (c, b) => ({ ...b, enabled: false }) }],
    ['db triggers drop', 'DELETE', '/database/triggers/{trigger}', 'Drop a trigger (table=)', { q: true, confirm: 'Drop this trigger?' }],
    ['db publication set', 'PATCH', '/database/publication', 'Add or remove tables from the realtime publication (add=[{"name":"t"}] remove=[...])'],
    ['db extensions install', 'POST', '/database/extensions/{extension}', 'Install an extension (schema=)'],
    ['db extensions remove', 'DELETE', '/database/extensions/{extension}', 'Remove an extension', { q: true, confirm: 'Remove this extension?' }],
    ['db policies create', 'POST', '/database/policies', 'Create a policy (table= name= command=select roles=["authenticated"] using= check= permissive=)'],
    ['db policies update', 'PATCH', '/database/policies/{policy}', 'Change a policy (schema= table= roles= using= check= new_name=)', { qkeys: ['schema', 'table'] }],
    ['db policies drop', 'DELETE', '/database/policies/{policy}', 'Drop a policy (schema= table=)', { q: true, confirm: 'Drop this policy?' }],
    ['db connections cancel', 'POST', '/database/connections/{pid}/cancel', 'Cancel the running query of a connection'],
    ['db connections end', 'POST', '/database/connections/{pid}/terminate', 'End a connection', { confirm: 'End this connection?' }],
    ['db rls users', 'GET', '/database/rls/users', 'Users to test row level security as (q=)'],
    ['db rls rows', 'GET', '/database/rls/rows', 'Rows to test row level security on (q=)', { usage: '[ref] <schema.table> [q=]', body: tableBody, need: 1 }],
    ['db rls explain', 'POST', '/database/rls/explain', 'Why a user sees or misses a row (who= pk= command=)', { usage: '[ref] <schema.table> who=\'{"type":"user","id":"<uuid>"}\' pk=\'{"id":1}\' [command=select]', body: tableBody, need: 1 }],
    ['db roles', 'GET', '/database/roles', 'Database login roles you created'],
    ['db roles create', 'POST', '/database/roles', 'Create a login role (name= preset=read-only|read-write|none schemas=[...] conn_limit= valid_until=); the password is shown once'],
    ['db roles update', 'PATCH', '/database/roles/{role}', 'Change a role (preset= schemas= login= conn_limit= valid_until=; reset_password=true: a new password, shown once)'],
    ['db roles delete', 'DELETE', '/database/roles/{role}', 'Drop a role', { confirm: 'Drop this role?' }],
  ]),
  ...group('Vault', [
    ['vault list', 'GET', '/vault/secrets', 'Vault secrets: names and descriptions (values are revealed in the dashboard only)'],
    ['vault create', 'POST', '/vault/secrets', 'Store a secret (name= description=); the value is read hidden', { secret: { field: 'secret', label: 'Secret value', required: true } }],
    ['vault update', 'PATCH', '/vault/secrets/{uuid}', 'Change a secret (name= description=; --secret-stdin / --secret-file for a new value)', { secret: { field: 'secret', label: 'New value' } }],
    ['vault delete', 'DELETE', '/vault/secrets/{uuid}', 'Delete a secret', { confirm: 'Delete this Vault secret?' }],
  ]),
  ...group('SQL', [
    ['sql history', 'GET', '/sql/history', 'Queries run from the SQL editor (limit=)'],
    ['sql history clear', 'DELETE', '/sql/history', 'Clear the SQL history', { confirm: 'Clear the SQL history?' }],
    ['sql snippets', 'GET', '/sql/snippets', 'Saved SQL snippets'],
    ['sql snippets create', 'POST', '/sql/snippets', 'Save a snippet (name= query=)'],
    ['sql snippets update', 'PATCH', '/sql/snippets/{uuid}', 'Change a snippet (name= query=)'],
    ['sql snippets delete', 'DELETE', '/sql/snippets/{uuid}', 'Delete a snippet', { confirm: 'Delete this snippet?' }],
    ['sql-http status', 'GET', '/sql-http', 'SQL over HTTP: state, settings and keys (hints only)'],
    ['sql-http on', 'POST', '/sql-http/enable', 'Turn SQL over HTTP on'],
    ['sql-http off', 'POST', '/sql-http/disable', 'Turn SQL over HTTP off'],
    ['sql-http settings', 'POST', '/sql-http/settings', 'Change the statement timeout (statement_timeout_s=)'],
    ['sql-http keys create', 'POST', '/sql-http/keys', 'Create a key (name=); shown once'],
    ['sql-http keys revoke', 'DELETE', '/sql-http/keys/{sqlkey}', 'Revoke a key', { confirm: 'Revoke this key?' }],
    ['test-data status', 'GET', '/test-data', 'Test data: tables it can fill and earlier runs'],
    ['test-data preview', 'POST', '/test-data/preview', 'Preview generated rows (tables=\'{"public.todos":10}\' users= preset=small|medium|large seed=)'],
    ['test-data run', 'POST', '/test-data/runs', 'Fill tables with generated rows (as preview; confirm=<ref> on production projects)'],
    ['test-data get', 'GET', '/test-data/runs/{tdrun}', 'One run with its progress'],
    ['test-data undo', 'DELETE', '/test-data/runs/{tdrun}', 'Remove the rows a run inserted', { confirm: 'Remove the rows this run inserted?' }],
  ]),
  ...group(AU, [
    ['auth users list', 'GET', '/auth/users', 'Users of the app (q= limit= offset= sort=created_at.desc)'],
    ['auth users get', 'GET', '/auth/users/{uuid}', 'One user with identities and factors'],
    ['auth users create', 'POST', '/auth/users', 'Create a user (email= email_confirm=true user_metadata=; the password, 8+ characters, is read hidden)', { secret: { field: 'password', label: 'Password', required: true } }],
    ['auth users update', 'PATCH', '/auth/users/{uuid}', 'Change a user (email= email_confirm= ban_duration=24h user_metadata=; --secret-stdin: a new password)', { secret: { field: 'password', label: 'New password' } }],
    ['auth users delete', 'DELETE', '/auth/users/{uuid}', 'Delete a user', { confirm: 'Delete this user?' }],
    ['auth users recovery-link', 'POST', '/auth/users/{uuid}/recovery-link', 'A one-time sign-in recovery link for a user (owners and administrators)'],
    ['auth users sign-out', 'POST', '/auth/users/{uuid}/sign-out', 'Sign a user out everywhere'],
    ['auth users send-recovery', 'POST', '/auth/users/{uuid}/send-recovery', 'E-mail a user a password recovery link'],
    ['auth users send-magic-link', 'POST', '/auth/users/{uuid}/send-magic-link', 'E-mail a user a magic sign-in link'],
    ['auth invite', 'POST', '/auth/invite', 'Invite a user by e-mail (email= redirect_to=)'],
    ['auth email-domain', 'GET', '/auth/email', 'Sending domain for Auth e-mails: state and the DNS records to publish'],
    ['auth email-domain add', 'POST', '/auth/email/domain', 'Send Auth e-mails from your own domain (domain= local=noreply); returns DNS records'],
    ['auth email-domain verify', 'POST', '/auth/email/domain/verify', 'Check the DNS records of the sending domain'],
    ['auth email-domain update', 'PATCH', '/auth/email/domain', 'Change the sender address (local=)'],
    ['auth email-domain remove', 'DELETE', '/auth/email/domain', 'Stop sending from your domain', { confirm: 'Stop sending Auth e-mails from your domain?' }],
    ['auth orgs status', 'GET', '/auth/orgs', 'Organizations for your app\'s users: state and settings'],
    ['auth orgs on', 'POST', '/auth/orgs/enable', 'Turn organizations on'],
    ['auth orgs off', 'POST', '/auth/orgs/disable', 'Turn organizations off (drop=true also deletes their data)', { confirm: 'Turn organizations off?' }],
    ['auth orgs settings', 'PATCH', '/auth/orgs/settings', 'Change organization settings (roles= default_role= anyone_can_create= max_orgs_per_user= invite_days= invite_url=)'],
    ['auth orgs list', 'GET', '/auth/orgs/list', 'Organizations your users created (q= limit= offset=)'],
    ['auth orgs get', 'GET', '/auth/orgs/list/{uuid}', 'One organization with its members'],
    ['auth signup-protection', 'GET', '/auth/signup-protection', 'Sign-up protection: disposable e-mail, bot checks, proof of work, rates, domain lists'],
    ['auth signup-protection set', 'PUT', '/auth/signup-protection', 'Change sign-up protection (disposable= bots= pow=auto|always|off ip_hour= net_hour= block_domains=[...] allow_domains=[...])'],
    ['hosted-login status', 'GET', '/hosted-login', 'Hosted sign-in page: state, URL and branding'],
    ['hosted-login on', 'POST', '/hosted-login', 'Turn the hosted sign-in page on'],
    ['hosted-login off', 'DELETE', '/hosted-login', 'Turn it off', { confirm: 'Turn the hosted sign-in page off?' }],
    ['hosted-login set', 'PUT', '/hosted-login/settings', 'Change branding and sign-in methods (title= logo_url= accent= theme= language= password= magic_link= sign_up= providers=[...] terms_url= privacy_url=)'],
  ]),
  ...group(ST, [
    ['storage buckets', 'GET', '/storage/buckets', 'Buckets with their size and object count'],
    ['storage buckets create', 'POST', '/storage/buckets', 'Create a bucket (name= public=true file_size_limit= allowed_mime_types=[...])'],
    ['storage buckets update', 'PATCH', '/storage/buckets/{bucket}', 'Replace a bucket\'s settings (public= file_size_limit= allowed_mime_types=; omitted ones reset)'],
    ['storage buckets delete', 'DELETE', '/storage/buckets/{bucket}', 'Delete a bucket and all its files', { confirm: 'Delete this bucket and all its files?' }],
    ['storage ls', 'POST', '/storage/list', 'Files in a bucket folder', { usage: '[ref] <bucket> [prefix] [limit=100] [search=]', need: 2, body: (c, b) => ({ bucket: need(c.args[0], 'Give the bucket.'), ...(c.args[1] ? { prefix: c.args[1] } : {}), ...b }) }],
    ['storage mv', 'POST', '/storage/move', 'Move or rename a file', { usage: '[ref] <bucket> <from> <to>', need: 3, body: (c) => ({ bucket: need(c.args[0], 'Give the bucket.'), from: need(c.args[1], 'Give the file.'), to: need(c.args[2], 'Give the new path.') }) }],
    ['storage rm', 'POST', '/storage/delete', 'Delete files', { usage: '[ref] <bucket> <path>...', need: 2, confirm: 'Delete these files?', body: (c) => ({ bucket: need(c.args[0], 'Give the bucket.'), paths: c.args.slice(1).length ? c.args.slice(1) : U.fail('Give the files.') }) }],
    ['storage sign', 'POST', '/storage/sign', 'A signed download URL for a file', { usage: '[ref] <bucket> <path> [expires_in=3600]', need: 2, body: (c, b) => ({ bucket: need(c.args[0], 'Give the bucket.'), path: need(c.args[1], 'Give the file.'), ...b }) }],
    ['storage mkdir', 'POST', '/storage/folder', 'Create a folder', { usage: '[ref] <bucket> <path>', need: 2, body: (c) => ({ bucket: need(c.args[0], 'Give the bucket.'), path: need(c.args[1], 'Give the folder.') }) }],
    ['storage s3 list', 'GET', '/storage/s3', 'S3 access keys (ids and names only)'],
    ['storage s3 create', 'POST', '/storage/s3', 'Create an S3 access key (description=); the secret is shown once'],
    ['storage s3 revoke', 'DELETE', '/storage/s3/{uuid}', 'Revoke an S3 access key', { confirm: 'Revoke this S3 key?' }],
    ['storage image-usage', 'GET', '/storage/image-usage', 'Image transformations used this month'],
  ]),
  ...group('Integrations', [
    ['stripe status', 'GET', '/stripe', 'Stripe sync: state, tables and last events'],
    ['stripe connect', 'PATCH', '/stripe', 'Connect Stripe sync (the secret key is read hidden; --webhook-secret-file: the webhook signing secret; stored sealed)', { secret: { field: 'secret_key', label: 'Stripe secret key (empty: keep the saved one)', prompt: true },
      flags: { webhookSecretFile: { type: 'string' } }, body: (c, b) => (c.flags.webhookSecretFile ? { ...b, webhook_secret: M.readText(c.flags.webhookSecretFile).trim() } : b) }],
    ['stripe backfill', 'POST', '/stripe/backfill', 'Copy existing Stripe data into the tables'],
    ['stripe disconnect', 'DELETE', '/stripe', 'Disconnect Stripe sync', { confirm: 'Disconnect Stripe sync?' }],
    ['import supabase projects', 'POST', '/import/supabase/projects', 'Projects of a Supabase account (the access token sbp_… is read hidden, used once, not stored)', { secret: { field: 'token', label: 'Supabase access token', required: true } }],
    ['import supabase project', 'POST', '/import/supabase/project', 'Details of one Supabase project to import (ref=)', { secret: { field: 'token', label: 'Supabase access token', required: true } }],
    ['import cancel', 'DELETE', '/import', 'Cancel a running import', { confirm: 'Cancel the import?' }],
  ]),
  ...group('Realtime', [
    ['realtime history', 'GET', '/realtime/history', 'Realtime message history: state and recent messages'],
    ['realtime history on', 'POST', '/realtime/history', 'Turn message history on'],
    ['realtime history off', 'DELETE', '/realtime/history', 'Turn message history off', { confirm: 'Turn message history off?' }],
  ]),
  ...group('Search', [
    ['search status', 'GET', '/search', 'Search: indexes and their state'],
    ['search indexes add', 'POST', '/search/indexes', 'Add a search index (table=public.products columns=[...] language= semantic=true)'],
    ['search indexes remove', 'DELETE', '/search/indexes/{id}', 'Remove a search index', { confirm: 'Remove this index?' }],
    ['search key set', 'PUT', '/search/key', 'Set the embeddings provider key (base_url= model= dims=; the key is read hidden, stored sealed)', { secret: { field: 'api_key', label: 'Provider API key', required: true } }],
    ['search key remove', 'PUT', '/search/key', 'Remove the embeddings provider key', { body: () => ({ api_key: null }), confirm: 'Remove the provider key?' }],
    ['search try', 'POST', '/search/try', 'Try a keyword search (id=<index id> q= limit=)'],
  ]),
  ...group('Background jobs', [
    ['jobs status', 'GET', '/jobs', 'Background jobs: state and job types'],
    ['jobs on', 'POST', '/jobs/enable', 'Turn background jobs on'],
    ['jobs off', 'POST', '/jobs/disable', 'Turn background jobs off', { confirm: 'Turn background jobs off?' }],
  ]),
  ...group('Analytics', [
    ['analytics on', 'POST', '/analytics', 'Turn product analytics on'],
    ['analytics off', 'DELETE', '/analytics', 'Turn product analytics off', { confirm: 'Turn product analytics off?' }],
    ['analytics settings', 'PUT', '/analytics/settings', 'Change analytics settings (scrub_fields=[...])'],
  ]),
  ...group('Offline sync', [
    ['sync status', 'GET', '/sync', 'Offline sync: synced tables and state'],
    ['sync tables add', 'POST', '/sync/tables', 'Sync a table (conflict=last_write_wins|server_wins|client_wins|custom resolver=)', { usage: '[ref] <schema.table> [conflict=...]', body: (c, b) => ({ table: need(c.args[0], 'Give the table.'), ...b }), need: 1 }],
    ['sync tables update', 'PUT', '/sync/tables/{id}', 'Change a synced table (conflict= resolver=)'],
    ['sync tables remove', 'DELETE', '/sync/tables/{id}', 'Stop syncing a table', { confirm: 'Stop syncing this table?' }],
  ]),
  ...group('Collaboration', [
    ['collab status', 'GET', '/collab', 'Collaborative documents: state and documents'],
    ['collab on', 'POST', '/collab', 'Turn collaboration on'],
    ['collab off', 'DELETE', '/collab', 'Turn collaboration off', { confirm: 'Turn collaboration off?' }],
    ['collab get', 'GET', '/collab/docs/{doc}', 'One document with snapshots and members'],
    ['collab delete', 'DELETE', '/collab/docs/{doc}', 'Delete a document', { confirm: 'Delete this document?' }],
    ['collab snapshot', 'POST', '/collab/docs/{doc}/snapshots', 'Take a snapshot (label=)'],
    ['collab snapshot-delete', 'DELETE', '/collab/docs/{doc}/snapshots/{snapshot}', 'Delete a snapshot', { confirm: 'Delete this snapshot?' }],
    ['collab grant', 'POST', '/collab/docs/{doc}/members', 'Give a user access (user=<e-mail or id> role=editor|viewer)'],
    ['collab revoke', 'DELETE', '/collab/docs/{doc}/members/{member}', 'Remove a user\'s access'],
  ]),
  ...group('SQL reports', [
    ['reports list', 'GET', '/reports', 'Scheduled SQL reports'],
    ['reports create', 'POST', '/reports', 'Create a report (name= query= cron= timezone= destinations=[{"type":"email","to":"…"}] format= only_if_rows=)'],
    ['reports preview', 'POST', '/reports/preview', 'Run a report query once and show the result (query= cron= timezone=)'],
    ['reports schedule', 'GET', '/reports/schedule', 'Next run times of a cron expression (cron= timezone=)'],
    ['reports get', 'GET', '/reports/{uuid}', 'One report'],
    ['reports update', 'PATCH', '/reports/{uuid}', 'Change a report (fields of reports create)'],
    ['reports delete', 'DELETE', '/reports/{uuid}', 'Delete a report', { confirm: 'Delete this report?' }],
    ['reports runs', 'GET', '/reports/{uuid}/runs', 'Past runs of a report'],
    ['reports run', 'POST', '/reports/{uuid}/run', 'Run a report now (destination=<id>: only that one)'],
  ]),
  ...group('Health alerts', [
    ['health-alerts status', 'GET', '/health-alerts', 'Health alerts: state, rules and channels (tokens as hints)'],
    ['health-alerts on', 'POST', '/health-alerts', 'Turn health alerts on'],
    ['health-alerts off', 'DELETE', '/health-alerts', 'Turn health alerts off', { confirm: 'Turn health alerts off?' }],
    ['health-alerts set', 'PUT', '/health-alerts/settings', 'Change alert channels (alert_email= alert_webhook= alert_recovered= telegram.chat_id=; --secret-stdin: the Telegram bot token, stored sealed)', { secret: { field: 'telegram.bot_token' } }],
    ['health-alerts test', 'POST', '/health-alerts/test', 'Send a test alert'],
  ]),
  ...group('Other', [
    ['functions get', 'GET', '/functions/{name}', 'One Edge Function: version, settings and state'],
    ['metering customer', 'GET', '/metering/customers/{customer}', 'Daily usage of one end customer'],
    ['backups job', 'GET', '/backups/jobs/{id}', 'One restore or backup job'],
    ['typegen get', 'GET', '/typegen', 'Typed clients: languages, GitHub sync and the last generation'],
    ['typegen set', 'PUT', '/typegen', 'Change typed clients (languages=[...] schemas=[...] github.repo=; --secret-stdin: a GitHub token, stored sealed)', { secret: { field: 'github.token' } }],
    ['typegen regenerate', 'POST', '/typegen/regenerate', 'Generate the typed clients now'],
    ['typegen github-sync', 'POST', '/typegen/github/sync', 'Open the GitHub pull request with the types now'],
  ]),
  // ---------- account ----------
  ...account('Billing', [
    ['billing', 'GET', '/billing', 'Plan, prepaid balance, spending caps and this month\'s usage'],
    ['billing ledger', 'GET', '/billing/ledger', 'Balance history (top-ups and charges)'],
    ['billing invoices', 'GET', '/billing/invoices', 'Invoices'],
    ['billing upcoming', 'GET', '/billing/upcoming', 'What the next invoice holds so far'],
    ['billing cap set', 'PUT', '/billing/cap', 'Set the monthly spending cap (cap_cents=)'],
    ['billing cap withdraw', 'DELETE', '/billing/cap/request', 'Withdraw a pending cap-raise request'],
    ['billing spend-cap', 'PUT', '/billing/spend-cap', 'Turn the spend cap on or off (enabled=true|false)'],
    ['billing pitr', 'PUT', '/billing/pitr', 'Point-in-time recovery add-on for a project (ref= days=7|14|28|0)'],
  ]),
  ...account('Dedicated servers', [
    ['compute catalog', 'GET', '/compute/catalog', 'Dedicated server sizes and prices (location= kind=)'],
    ['compute servers cancel', 'POST', '/compute/servers/{id}/cancel', 'Cancel a dedicated server', { confirm: 'Cancel this dedicated server?' }],
    ['compute servers resize', 'POST', '/compute/servers/{id}/resize', 'Resize a dedicated server (size_key=)'],
  ]),
  ...account('Own servers', [
    ['servers list', 'GET', '/servers', 'Your own servers'],
    ['servers locations', 'GET', '/servers/locations', 'Regions you can add own servers in'],
    ['servers add', 'POST', '/servers', 'Add your own server (name= host= region=; ssh_key=@file, or --secret-stdin / --secret-file: the root password, used once)',
      { secret: { field: 'root_password' }, body: async (c, b) => (typeof b.ssh_key === 'string' && b.ssh_key.startsWith('@') ? { ...b, ssh_key: M.readText(b.ssh_key.slice(1)) } : b) }],
    ['servers get', 'GET', '/servers/{server}', 'One own server with its state'],
    ['servers log', 'GET', '/servers/{server}/log', 'Its install log'],
    ['servers retry', 'POST', '/servers/{server}/retry', 'Retry the install'],
    ['servers remove', 'DELETE', '/servers/{server}', 'Remove an own server', { confirm: 'Remove this server?' }],
    ['servers projects', 'POST', '/servers/{server}/projects', 'Choose which projects use it (refs=[...])'],
    ['servers move', 'POST', '/servers/{server}/move', 'Move a project onto it (ref=)'],
    ['servers move-off', 'POST', '/servers/move-off', 'Move a project back to StitchDB servers (ref=)'],
  ]),
  ...account('Support', [
    ['support list', 'GET', '/support/tickets', 'Your support tickets'],
    ['support open', 'POST', '/support/tickets', 'Open a ticket (subject= body= project_ref= priority=)'],
    ['support get', 'GET', '/support/tickets/{id}', 'One ticket with its messages'],
    ['support reply', 'POST', '/support/tickets/{id}/messages', 'Reply to a ticket (body=)'],
    ['support close', 'POST', '/support/tickets/{id}/status', 'Close a ticket', { body: () => ({ status: 'closed' }) }],
    ['support reopen', 'POST', '/support/tickets/{id}/status', 'Reopen a ticket', { body: () => ({ status: 'open' }) }],
    ['support download', 'GET', '/support/attachments/{uuid}', 'Download an attachment', { raw: true }],
  ]),
  ...account('AI assistant', [
    ['ai status', 'GET', '/ai/status', 'Whether the AI assistant is available and this month\'s use'],
  ]),
];

const extra = {
  // ---------- friendly Auth commands ----------
  'auth smtp get': {
    group: AU, summary: 'Custom SMTP settings for Auth e-mails (the password is never shown)', usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const c = await api.get(`/projects/${ref}/config/auth`);
      const s = c.smtp;
      U.output({ smtp: s, sender_name: c.sender_name, email_enabled: c.email_enabled }, () => M.fields(s
        ? [['Host', s.host], ['Port', String(s.port)], ['User', s.user], ['From', s.admin_email], ['Sender name', c.sender_name], ['Password', s.has_pass ? 'set' : 'not set'], ['E-mail sign-in', M.yes(c.email_enabled)]]
        : [['SMTP', 'StitchDB\'s (no custom SMTP)'], ['Sender name', c.sender_name], ['E-mail sign-in', M.yes(c.email_enabled)]]));
      return c.smtp;
    },
  },
  'auth smtp set': {
    group: AU, summary: 'Send Auth e-mails through your own SMTP server',
    usage: '[ref] --host <host> [--port 587] --user <user> --from <address> [--sender-name <name>] [--secret-stdin | --secret-file <file>]',
    description: 'The password is read hidden (or from --secret-stdin / --secret-file), stored encrypted and never shown again. Without a new password the saved one is kept.',
    options: `--host <host>         SMTP host (smtp.example.com)
--port <port>         25, 465, 587, 2465, 2525 or 2587 (default 587)
--user <user>         SMTP user name
--from <address>      The address e-mails come from
--sender-name <name>  The name e-mails come from
--keep-password       Keep the saved password (no prompt)
${SECRET_OPT}`,
    examples: 'stitchdb auth smtp set --host smtp.resend.com --port 587 --user resend --from no-reply@example.com --sender-name "Example"\necho "$SMTP_PASS" | stitchdb auth smtp set --host smtp.example.com --user me --from me@example.com --secret-stdin',
    flags: { ...FLAGS, host: { type: 'string' }, port: { type: 'string' }, user: { type: 'string' }, from: { type: 'string' }, senderName: { type: 'string' }, keepPassword: { type: 'boolean' } },
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const smtp = { host: need(flags.host, 'Pass --host.'), port: Number(flags.port || 587), user: flags.user || '', admin_email: need(flags.from, 'Pass --from (the sender address).') };
      const pass = flags.keepPassword ? undefined : await secretOf(flags, 'SMTP password (empty: keep the saved one)', { prompt: true });
      if (pass) smtp.pass = pass;
      const body = { smtp };
      if (flags.senderName !== undefined) body.sender_name = flags.senderName;
      const r = await api.patch(`/projects/${ref}/config/auth`, body);
      U.output(r, () => U.ok(`Auth e-mails now go through ${smtp.host}:${smtp.port}${r.restarted ? ' (Auth restarted)' : ''}. Try it: stitchdb auth templates test confirmation`));
      return r;
    },
  },
  'auth smtp remove': {
    group: AU, summary: 'Go back to StitchDB\'s e-mail sending', usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      await M.confirm(flags, 'Remove the custom SMTP settings?');
      const r = await api.patch(`/projects/${ref}/config/auth`, { smtp: null });
      U.output(r, () => U.ok('Custom SMTP removed.'));
      return r;
    },
  },
  'auth templates test': {
    group: AU, summary: 'E-mail yourself an Auth template as your users get it (owners and administrators)',
    usage: '[ref] <confirmation|invite|magic_link|recovery|email_change|reauthentication> [--lang de]',
    flags: { lang: { type: 'string' } },
    async run({ flags, args }) {
      const ref = F.refOf(flags, args, 1);
      const r = await api.post(`/projects/${ref}/config/auth/test-email`, { kind: need(args[0], 'Give the template (confirmation, invite, magic_link, recovery, email_change or reauthentication).'), ...(flags.lang ? { lang: flags.lang } : {}) });
      U.output(r, () => U.ok(`Test e-mail sent to ${r.to || 'you'}.`));
      return r;
    },
  },
  'auth templates set': {
    group: AU, summary: 'Change the subject and HTML of an Auth e-mail template',
    usage: '[ref] <kind> [--html <file>] [--subject <text>] [--lang de] [--reset]',
    description: 'Kinds: confirmation, invite, magic_link, recovery, email_change, reauthentication. Templates use Go template fields like {{ .ConfirmationURL }} and {{ .Token }}. --reset goes back to the default.',
    examples: 'stitchdb auth templates set recovery --html recovery.html --subject "Reset your password"',
    flags: { html: { type: 'string' }, subject: { type: 'string' }, lang: { type: 'string' }, reset: { type: 'boolean' } },
    async run({ flags, args }) {
      const ref = F.refOf(flags, args, 1);
      const kind = need(args[0], 'Give the template kind.');
      const body = { templates: {}, subjects: {} };
      if (flags.reset) { body.templates[kind] = ''; body.subjects[kind] = ''; }
      else {
        if (flags.html) body.templates[kind] = M.readText(flags.html);
        if (flags.subject !== undefined) body.subjects[kind] = flags.subject;
        if (!flags.html && flags.subject === undefined) U.fail('Pass --html <file>, --subject <text> or --reset.');
      }
      if (flags.lang) body.lang = flags.lang;
      const r = await api.patch(`/projects/${ref}/config/auth`, body);
      U.output(r, () => U.ok(`Saved the ${kind} template${flags.lang ? ` (${flags.lang})` : ''}. Try it: stitchdb auth templates test ${kind}`));
      return r;
    },
  },
  'auth email on': authBool('email_enabled', true, 'Turn e-mail sign-in (password, magic link, OTP) on', 'E-mail sign-in is on.'),
  'auth email off': authBool('email_enabled', false, 'Turn e-mail sign-in off', 'E-mail sign-in is off.'),
  'auth phone on': authBool('phone_enabled', true, 'Turn phone (SMS) sign-in on (set a provider with "auth sms set")', 'Phone sign-in is on.'),
  'auth phone off': authBool('phone_enabled', false, 'Turn phone (SMS) sign-in off', 'Phone sign-in is off.'),
  'auth signup on': authBool('disable_signup', false, 'Allow new sign-ups', 'New sign-ups are allowed.'),
  'auth signup off': authBool('disable_signup', true, 'Stop new sign-ups', 'New sign-ups are off.'),
  'auth autoconfirm on': authBool('mailer_autoconfirm', true, 'Sign users in without e-mail confirmation', 'Users are signed in without confirming their e-mail.'),
  'auth autoconfirm off': authBool('mailer_autoconfirm', false, 'Require e-mail confirmation before sign-in', 'Users confirm their e-mail before signing in.'),
  'auth anonymous on': authBool('anonymous_users', true, 'Allow anonymous sign-ins', 'Anonymous sign-ins are allowed.'),
  'auth anonymous off': authBool('anonymous_users', false, 'Refuse anonymous sign-ins', 'Anonymous sign-ins are off.'),
  'auth sms set': {
    group: AU, summary: 'Set the SMS provider for phone sign-in (Twilio, Twilio Verify, MessageBird, Textlocal, Vonage)',
    usage: '[ref] <provider> field=value... [--secret-stdin | --secret-file <file>]',
    description: 'The provider\'s secret (auth token, API key or secret) is read hidden, stored encrypted and never shown again. Without a new secret the saved one is kept.',
    options: SECRET_OPT,
    examples: 'stitchdb auth sms set twilio account_sid=AC123 message_service_sid=MG456\nstitchdb auth sms set vonage api_key=abc from=MyApp --secret-file vonage-secret.txt',
    flags: FLAGS,
    async run({ flags, args }) {
      const pos = args.filter((a) => !/^[A-Za-z_][\w.]*=/.test(a));
      const ref = F.refOf(flags, pos, 1);
      const provider = need(pos[0], 'Give the provider (twilio, twilio_verify, messagebird, textlocal or vonage).');
      const c = await api.get(`/projects/${ref}/config/auth`);
      const def = c.meta?.sms_providers?.[provider];
      if (!def) U.fail(`Unknown SMS provider "${provider}".`, { hint: `One of: ${Object.keys(c.meta?.sms_providers || {}).join(', ')}` });
      const sms = { provider, ...input(flags, args) };
      for (const f of def.fields.filter((x) => x.secret)) if (sms[f.key] === undefined) { const v = await secretOf(flags, `${def.label} ${f.label} (empty: keep the saved one)`, { prompt: true }); if (v) sms[f.key] = v; }
      const r = await api.patch(`/projects/${ref}/config/auth`, { sms });
      U.output(r, () => U.ok(`SMS goes through ${def.label}${r.restarted ? ' (Auth restarted)' : ''}. Turn phone sign-in on with "stitchdb auth phone on".`));
      return r;
    },
  },
  'auth sms remove': {
    group: AU, summary: 'Remove the SMS provider', usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      await M.confirm(flags, 'Remove the SMS provider (phone sign-in stops working)?');
      const r = await api.patch(`/projects/${ref}/config/auth`, { sms: null });
      U.output(r, () => U.ok('SMS provider removed.'));
      return r;
    },
  },
  'auth providers list': {
    group: AU, summary: 'Sign-in providers (Google, GitHub, Apple, ...) and whether they are on', usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const c = await api.get(`/projects/${ref}/config/auth`);
      const names = [...new Set([...Object.keys(c.meta?.providers || {}), ...Object.keys(c.providers || {})])];
      const list = names.map((n) => ({ provider: n, enabled: !!c.providers?.[n]?.enabled, client_id: c.providers?.[n]?.client_id || '', secret: c.providers?.[n]?.has_secret ? 'set' : '' }));
      U.output(list, () => U.table(['PROVIDER', 'ON', 'CLIENT ID', 'SECRET'], list.map((p) => [p.provider, p.enabled ? U.c.green('on') : '', p.client_id, p.secret])));
      return list;
    },
  },
  'auth providers enable': {
    group: AU, summary: 'Turn a sign-in provider on (Google, GitHub, Apple, ...: client id, and the secret read hidden)',
    usage: '[ref] <provider> [--client-id <id>] [--url <base url>] [--keep-secret] [--secret-stdin | --secret-file <file>]',
    description: 'The secret is stored encrypted and never shown again. Without a new secret the saved one is kept.',
    options: `--client-id <id>      The OAuth client id
--url <url>           Base URL (GitLab, Keycloak, Azure, WorkOS)
--keep-secret         Keep the saved secret (no prompt)
${SECRET_OPT}`,
    examples: 'stitchdb auth providers enable github --client-id Iv1.abc123\nstitchdb auth providers enable google --client-id 123.apps.googleusercontent.com --secret-file google-secret.txt',
    flags: { ...FLAGS, clientId: { type: 'string' }, url: { type: 'string' }, keepSecret: { type: 'boolean' } },
    async run({ flags, args }) {
      const ref = F.refOf(flags, args, 1);
      const name = need(args[0], 'Give the provider (stitchdb auth providers list).');
      if (!/^[a-z_]{2,30}$/.test(name)) U.fail('The provider is a name like github or google.');
      const p = { enabled: true };
      if (flags.clientId) p.client_id = flags.clientId;
      if (flags.url) p.url = flags.url;
      if (!flags.keepSecret) { const s = await secretOf(flags, `${name} client secret (empty: keep the saved one)`, { prompt: true }); if (s) p.secret = s; }
      const r = await api.patch(`/projects/${ref}/config/auth`, { providers: { [name]: p } });
      U.output(r, () => U.ok(`${name} sign-in is on${r.restarted ? ' (Auth restarted)' : ''}.`));
      return r;
    },
  },
  'auth providers disable': {
    group: AU, summary: 'Turn a sign-in provider off (its settings are kept)', usage: '[ref] <provider>',
    async run({ flags, args }) {
      const ref = F.refOf(flags, args, 1);
      const name = need(args[0], 'Give the provider.');
      const r = await api.patch(`/projects/${ref}/config/auth`, { providers: { [name]: { enabled: false } } });
      U.output(r, () => U.ok(`${name} sign-in is off.`));
      return r;
    },
  },
  'ai ask': aiCmd({ project: true }),
  'ai chat': aiCmd({ project: false }),
  // ---------- account ----------
  'orgs rename': {
    group: 'Organizations', summary: 'Rename an organization', usage: '[--org <id>] <new name>', flags: { org: { type: 'string' } },
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const r = await api.patch(`/organizations/${enc(org)}`, { name: need(args.join(' '), 'Give the new name.') });
      U.output(r, () => U.ok(`Renamed to ${r.name || args.join(' ')}.`));
      return r;
    },
  },
  'orgs invitations resend': {
    group: 'Organizations', summary: 'Send an invitation e-mail again', usage: '[--org <id>] <invitation id>', flags: { org: { type: 'string' } },
    async run({ flags, args }) {
      const org = await M.orgId(flags);
      const r = await api.post(`/organizations/${enc(org)}/invitations/${enc(need(args[0], 'Give the invitation id (stitchdb orgs invitations list).'))}/resend`, {});
      U.output(r, () => U.ok('Invitation sent again.'));
      return r;
    },
  },
  'support upload': {
    group: 'Support', summary: 'Upload a file to attach to a ticket (prints its attachment id)', usage: '<file>',
    async run({ args }) {
      const file = need(args[0], 'Give the file.');
      let buf; try { buf = fs.readFileSync(file); } catch (e) { U.fail(`Cannot read ${file}: ${e.code || e.message}`); }
      const { apiUrl, accessToken } = require('../config');
      const u = new URL(`${apiUrl()}/platform/v1/support/attachments`); u.searchParams.set('name', require('path').basename(file));
      const res = await fetch(u, { method: 'POST', headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/octet-stream' }, body: buf });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) U.fail(r.error || `Upload failed (${res.status})`);
      U.output(r, () => U.ok(`Uploaded ${file}: ${r.id || r.uuid || JSON.stringify(r)}`));
      return r;
    },
  },
  // ---------- any operation ----------
  api: {
    group: 'Other', summary: 'Call any Management API operation (stitchdb api GET /projects/<ref>/database/tables)',
    usage: '<METHOD> <path> [key=value]... [--file <json>] [--query key=value]...',
    description: `The path is after /platform/v1 (see https://stitchdb.com/docs/api). key=value pairs and --file make the JSON body;
for GET and DELETE they are the query string. --query adds query parameters to any method.`,
    options: `${FILE_OPT}
--query <key=value>   A query parameter, repeatable`,
    examples: 'stitchdb api GET /projects/abcdefghijklmnop/storage/buckets\nstitchdb api PATCH /projects/abcdefghijklmnop/config/auth site_url=https://app.example.com',
    flags: { ...FLAGS, query: { type: 'array' } },
    async run({ flags, args }) {
      const method = need(args.shift(), 'Give the method (GET, POST, PUT, PATCH or DELETE).').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) U.fail('The method is GET, POST, PUT, PATCH or DELETE.');
      let path = need(args.shift(), 'Give the path, like /projects/<ref>/storage/buckets.').replace(/^https?:\/\/[^/]+/, '').replace(/^\/?platform\/v1/, '');
      if (!path.startsWith('/')) path = '/' + path;
      if (/(^|\/)\.\.?(\/|$)|[?#\\]/.test(path)) U.fail('The path is a plain API path (no "..", "?" or "#"); pass query parameters with --query.');
      const body = input(flags, args);
      const query = {};
      for (const q of [].concat(flags.query || [])) { const i = String(q).indexOf('='); if (i <= 0) U.fail(`"${q}" is not key=value.`); query[q.slice(0, i)] = q.slice(i + 1); }
      const r = await request(method, path, method === 'GET' || method === 'DELETE' ? { query: { ...body, ...query } } : { body, query });
      U.output(r, () => show(r));
      return r;
    },
  },
};

// The AI assistant answers as a stream (server-sent events): text is printed as it arrives.
function aiCmd({ project }) {
  return {
    group: 'AI assistant', summary: project ? 'Ask the AI assistant about a project (schema-aware; read-only SQL)' : 'Ask the AI assistant (docs and general questions)',
    usage: project ? '[ref] "<question>"' : '"<question>"',
    async run({ flags, args }) {
      const ref = project ? F.refOf(flags, args, 1) : null;
      const question = need(args.join(' ').trim(), 'Ask a question.');
      const { apiUrl, accessToken } = require('../config');
      const res = await fetch(`${apiUrl()}/platform/v1${project ? `/projects/${ref}` : ''}/ai/chat`, { method: 'POST',
        headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages: [{ role: 'user', content: question }] }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); U.fail(j.error || `Request failed (${res.status})`); }
      let text = '', buf = '', ev = 'message';
      const out = { text: '', tools: [] };
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
            const kind = d.type || ev;
            if (kind === 'text' && d.t) { text += d.t; if (!U.state.json) process.stdout.write(d.t); }
            else if (kind === 'tool' && d.state === 'running' && d.label) { out.tools.push(d.label); if (!U.state.json) process.stderr.write(U.c.dim(`\n› ${d.label}\n`)); }
            else if (kind === 'error') U.fail(d.error || d.message || 'The AI assistant failed.');
          } else if (!line) ev = 'message';
        }
      }
      out.text = text;
      if (U.state.json) U.output(out, () => {}); else process.stdout.write('\n');
      return out;
    },
  };
}

function authBool(key, value, summary, msg) {
  return {
    group: AU, summary, usage: '[ref]',
    async run({ flags, args }) {
      const ref = M.projectRef(flags, args);
      const r = await api.patch(`/projects/${ref}/config/auth`, { [key]: value });
      U.output(r, () => U.ok(`${msg}${r.restarted ? ' (Auth restarted)' : ''}`));
      return r;
    },
  };
}

module.exports = { ...Object.fromEntries(cmds), ...extra, _dashboard: { make, secretOf } };
