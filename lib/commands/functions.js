// functions new|serve|deploy|list|delete|download, secrets list|set|unset, gen types typescript
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('../util');
const C = require('../config');
const api = require('../api');
const L = require('../local');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const SKIP = new Set(['node_modules', '.git', '.DS_Store', '.env', '.temp']);
const SHARED = '_shared';

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.env')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
const isText = (f) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|json|jsonc|md|txt|html|css|sql|svg|toml|yaml|yml)$/i.test(f);
// Imports of functions/_shared/... are rewritten to a copy of _shared inside the function's bundle.
function rewriteShared(code, fileInBundle) {
  const depth = fileInBundle.split('/').length - 1;
  return code.replace(/((?:from|import)\s*\(?\s*)(['"])((?:\.\.\/)+)_shared\//g, (all, pre, q, ups) => {
    if (ups.length / 3 !== depth + 1) return all; // points somewhere else
    return `${pre}${q}${depth ? '../'.repeat(depth) : './'}${SHARED}/`;
  });
}
function bundle(functionsDir, slug) {
  const dir = path.join(functionsDir, slug);
  if (!fs.existsSync(path.join(dir))) U.fail(`stitchdb/functions/${slug} does not exist.`, { hint: `Create it with "stitchdb functions new ${slug}".` });
  const names = listFiles(dir);
  if (!names.some((n) => /^index\.(ts|js|tsx|mjs)$/.test(n))) U.fail(`stitchdb/functions/${slug} has no index.ts.`);
  const files = [];
  let usesShared = false;
  for (const n of names) {
    const buf = fs.readFileSync(path.join(dir, n));
    if (isText(n)) {
      const text = buf.toString('utf8'), out = rewriteShared(text, n);
      if (out !== text) usesShared = true;
      files.push({ name: n, content: Buffer.from(out).toString('base64') });
    } else files.push({ name: n, content: buf.toString('base64') });
  }
  const shared = path.join(functionsDir, SHARED);
  if (usesShared && fs.existsSync(shared)) for (const n of listFiles(shared)) files.push({ name: `${SHARED}/${n}`, content: fs.readFileSync(path.join(shared, n)).toString('base64') });
  const importMap = ['deno.json', 'deno.jsonc', 'import_map.json'].find((f) => names.includes(f)) || null;
  const entrypoint = names.find((n) => /^index\.(ts|js|tsx|mjs)$/.test(n));
  return { files, importMap, entrypoint, bytes: files.reduce((a, f) => a + Buffer.from(f.content, 'base64').length, 0) };
}
function functionNames(functionsDir) {
  try {
    return fs.readdirSync(functionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SLUG_RE.test(e.name) && e.name !== SHARED && ['index.ts', 'index.js', 'index.tsx', 'index.mjs'].some((f) => fs.existsSync(path.join(functionsDir, e.name, f))))
      .map((e) => e.name).sort();
  } catch { return []; }
}
function verifyJwtFor(proj, slug, flags) {
  if (flags.verifyJwt === false) return false;
  const v = proj.cfg.functions?.[slug]?.verify_jwt;
  return v === undefined ? true : v !== false;
}

module.exports = {
  'functions new': {
    group: 'Edge Functions', summary: 'Create a new function from a template',
    usage: '<name> [--template hello|api]',
    options: `--template <name>  hello (default): a minimal function · api: the signed-in user and a client that acts as them (middleware)`,
    flags: { template: { type: 'string' } },
    async run({ flags, args }) {
      const proj = C.project(flags);
      const slug = args[0];
      const template = flags.template || 'hello';
      if (!['hello', 'api'].includes(template)) U.fail(`Unknown template "${template}".`, { hint: 'Templates: hello, api.' });
      if (!SLUG_RE.test(slug || '') || slug === SHARED) U.fail('Function names use letters, digits, - and _ (for example: send-email).');
      const file = path.join(proj.functionsDir, slug, 'index.ts');
      if (U.exists(file)) U.fail(`${U.rel(file)} already exists.`);
      U.writeFileSafe(file, fs.readFileSync(path.join(TEMPLATES, 'functions', template, 'index.ts'), 'utf8').replace(/__NAME__/g, slug));
      U.ok(`Created ${U.rel(file)}`);
      U.log(`Run it locally with ${U.c.cyan('stitchdb functions serve')}, deploy with ${U.c.cyan(`stitchdb functions deploy ${slug}`)}.`);
      return { slug, file };
    },
  },
  'functions serve': {
    group: 'Edge Functions', summary: 'Serve functions locally with live reload',
    description: 'Runs stitchdb/functions in the local stack (starts it if needed) at http://127.0.0.1:<api port>/functions/v1/<name>. Edits apply on the next request; secrets come from stitchdb/functions/.env. Shows the function logs until you press Ctrl+C.',
    async run({ flags }) {
      L.requireDocker();
      const proj = C.project(flags);
      let st = L.status(proj);
      if (!st.running) { await require('./local').start.run({ flags: { ...flags } }); st = L.status(proj); }
      else { L.writeStack(proj, st.s, JSON.parse(fs.readFileSync(path.join(st.s.dir, 'exclude.json'), 'utf8') || '[]')); L.dc(st.s, ['up', '-d', '--force-recreate', 'functions']); }
      const names = functionNames(proj.functionsDir);
      U.log(`\nServing ${names.length ? names.map((n) => U.c.bold(n)).join(', ') : 'no functions yet'} on ${L.urls(st.s).functions}/<name>  (Ctrl+C to stop following logs)\n`);
      L.dc(st.s, ['logs', '-f', '--no-log-prefix', '--since', '1s', 'functions'], { inherit: true, allowFail: true });
      return undefined;
    },
  },
  'functions deploy': {
    group: 'Edge Functions', summary: 'Deploy functions to the linked project (or a branch)',
    usage: '[name...] [--all] [--no-verify-jwt]',
    description: 'Uploads stitchdb/functions/<name> (with files from functions/_shared it imports) as a new version. Without names: every function.',
    options: `--all            Deploy every function in stitchdb/functions
--no-verify-jwt  Allow calls without a valid JWT (webhooks); default from config.toml [functions.<name>]
--if-present     Do nothing (instead of failing) when there are no functions`,
    flags: { all: { type: 'boolean' }, verifyJwt: { type: 'boolean' }, ifPresent: { type: 'boolean' } },
    async run({ flags, args }) {
      const proj = C.project(flags);
      const ref = C.targetRef(flags, proj);
      const names = args.length ? args : functionNames(proj.functionsDir);
      if (!names.length) { if (flags.ifPresent) { U.ok('No functions to deploy.'); return { deployed: [] }; } U.fail('No functions in stitchdb/functions.', { hint: 'Create one with "stitchdb functions new <name>".' }); }
      const deployed = [];
      for (const slug of names) {
        if (!SLUG_RE.test(slug)) U.fail(`Invalid function name "${slug}".`);
        const b = bundle(proj.functionsDir, slug);
        const sp = U.spinner(`Deploying ${slug} (${(b.bytes / 1024).toFixed(1)} KB)…`);
        const r = await api.post(`/projects/${ref}/functions`, { slug, name: slug, verify_jwt: verifyJwtFor(proj, slug, flags), entrypoint: b.entrypoint, import_map: b.importMap, files: b.files }).finally(() => sp.stop());
        deployed.push({ slug, version: r.version, url: r.url || `${(await api.get(`/projects/${ref}`)).api_url}/functions/v1/${slug}` });
        U.ok(`Deployed ${U.c.bold(slug)} v${r.version ?? '?'} → ${deployed.at(-1).url}`);
      }
      return { deployed };
    },
  },
  'functions list': {
    group: 'Edge Functions', summary: 'List deployed functions',
    async run({ flags }) {
      const ref = C.targetRef(flags, C.project(flags, { required: false }));
      const list = await api.get(`/projects/${ref}/functions`);
      const rows = Array.isArray(list) ? list : list.functions || [];
      U.output(rows, (r) => U.table(['NAME', 'VERSION', 'VERIFY JWT', 'UPDATED'], r.map((f) => [f.slug, String(f.version ?? ''), f.verify_jwt ? 'yes' : 'no', U.ago(f.updated_at)])));
      return rows;
    },
  },
  'functions delete': {
    group: 'Edge Functions', summary: 'Delete a deployed function',
    usage: '<name>',
    async run({ flags, args }) {
      const ref = C.targetRef(flags, C.project(flags, { required: false }));
      const slug = args[0];
      if (!SLUG_RE.test(slug || '')) U.fail('Give the function name.');
      if (!(await U.confirm(`Delete function ${slug} from ${ref}? Its URL stops working.`, { yes: flags.yes }))) U.fail('Cancelled.', { code: 2 });
      await api.del(`/projects/${ref}/functions/${slug}`);
      U.ok(`Deleted ${slug}.`);
      return { deleted: slug };
    },
  },
  'functions download': {
    group: 'Edge Functions', summary: 'Download a deployed function into stitchdb/functions',
    usage: '<name>',
    async run({ flags, args }) {
      const proj = C.project(flags);
      const ref = C.targetRef(flags, proj);
      const slug = args[0];
      if (!SLUG_RE.test(slug || '')) U.fail('Give the function name.');
      const body = await api.get(`/projects/${ref}/functions/${slug}/body`);
      for (const f of body.files) U.writeFileSafe(path.join(proj.functionsDir, slug, f.name), Buffer.from(f.content, f.encoding === 'utf8' ? 'utf8' : 'base64'));
      U.ok(`Wrote ${body.files.length} file${body.files.length === 1 ? '' : 's'} to stitchdb/functions/${slug} (version ${body.version}).`);
      return { slug, version: body.version, files: body.files.length };
    },
  },

  'secrets list': {
    group: 'Edge Functions', summary: 'List function secrets (names and digests)',
    async run({ flags }) {
      const ref = C.targetRef(flags, C.project(flags, { required: false }));
      const list = await api.get(`/projects/${ref}/secrets`);
      U.output(list, (r) => U.table(['NAME', 'DIGEST (SHA-256)', 'UPDATED'], r.map((s) => [s.name, String(s.digest || '').slice(0, 16), U.ago(s.updated_at)])));
      return list;
    },
  },
  'secrets set': {
    group: 'Edge Functions', summary: 'Set function secrets',
    usage: 'NAME=value ... | --env-file <file>',
    description: 'Secrets are environment variables for every function of the project (Deno.env.get("NAME")). Values are write-only.',
    examples: 'stitchdb secrets set STRIPE_KEY=sk_live_...\nstitchdb secrets set --env-file stitchdb/functions/.env',
    flags: { envFile: { type: 'string' } },
    async run({ flags, args }) {
      const ref = C.targetRef(flags, C.project(flags, { required: false }));
      const items = [];
      const add = (line) => {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m) return false;
        let v = m[2];
        if (/^".*"$/.test(v)) v = JSON.parse(v); else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
        items.push({ name: m[1], value: v });
        return true;
      };
      if (flags.envFile) for (const l of fs.readFileSync(flags.envFile, 'utf8').split(/\r?\n/)) { if (l.trim() && !l.trim().startsWith('#')) add(l); }
      for (const a of args) if (!add(a)) U.fail(`"${a}" is not NAME=value.`);
      if (!items.length) U.fail('Nothing to set.', { hint: 'stitchdb secrets set NAME=value' });
      await api.post(`/projects/${ref}/secrets`, items);
      U.ok(`Set ${items.map((s) => s.name).join(', ')}. Functions see the new values on their next request.`);
      return { set: items.map((s) => s.name) };
    },
  },
  'secrets unset': {
    group: 'Edge Functions', summary: 'Remove function secrets',
    usage: 'NAME ...',
    async run({ flags, args }) {
      const ref = C.targetRef(flags, C.project(flags, { required: false }));
      if (!args.length) U.fail('Give the secret names to remove.');
      await api.request('DELETE', `/projects/${ref}/secrets`, { body: args });
      U.ok(`Removed ${args.join(', ')}.`);
      return { removed: args };
    },
  },

  'gen types typescript': {
    group: 'Database', summary: 'Generate TypeScript types from your schema',
    usage: '[--local | --linked | --project-ref <ref>] [-s <schemas>]',
    description: 'Prints a Database type for stitchdb-js (createClient<Database>(...)). Redirect it to a file.',
    examples: 'stitchdb gen types typescript --linked > src/database.types.ts\nstitchdb gen types typescript --local -s public,api > types.ts',
    flags: { local: { type: 'boolean' }, linked: { type: 'boolean' }, schema: { type: 'array', alias: 's' } },
    async run({ flags }) {
      const schemas = flags.schema?.length ? flags.schema : ['public'];
      for (const x of schemas) if (!/^[a-z_][a-z0-9_]*$/.test(x)) U.fail(`Invalid schema ${x}`);
      let types;
      if (flags.local) {
        const proj = C.project(flags);
        const st = L.status(proj);
        if (!st.running) U.fail('The local stack is not running.', { hint: 'Run "stitchdb start" first.' });
        const arr = `array[${schemas.map((x) => `'${x}'`).join(',')}]::text[]`;
        types = await require('../types').generate(async (sql) => L.queryJson(st.s, sql.replace(/\$1\b/g, arr)), schemas);
      } else {
        const ref = C.targetRef(flags, C.project(flags, { required: false }));
        ({ types } = await api.get(`/projects/${ref}/types/typescript`, { query: { schemas: schemas.join(',') } }));
      }
      if (U.state.json) return { types };
      process.stdout.write(types.endsWith('\n') ? types : types + '\n');
      return undefined;
    },
  },
  _internal: { hidden: true, bundle, rewriteShared, functionNames },
};
