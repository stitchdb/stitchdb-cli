// login, logout, projects list, projects api-keys, link, unlink, init
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const U = require('../util');
const C = require('../config');
const api = require('../api');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const TOKEN_RE = /^sdb_(pat|oat)_[A-Za-z0-9_-]{20,}$/;

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); } catch {}
}

module.exports = {
  login: {
    group: 'Account', summary: 'Log in with an access token',
    usage: '[--token <token>] [--no-browser]',
    description: `Stores a personal access token in ~/.stitchdb/credentials (readable only by you).
Create one in the dashboard: Account → Access tokens (read-write to deploy). In CI, set STITCHDB_ACCESS_TOKEN instead.`,
    options: `--token <token>   Use this token (otherwise you are asked for it)
--no-browser      Don't open the access tokens page`,
    flags: { token: { type: 'string' }, browser: { type: 'boolean' } },
    async run({ flags }) {
      let token = flags.token || process.env.STITCHDB_ACCESS_TOKEN_INPUT;
      const page = `${C.apiUrl()}/dashboard/account/tokens`;
      if (!token) {
        U.log(`Create an access token at ${U.c.cyan(page)}${flags.browser !== false && process.stdout.isTTY ? ' (opening it now)' : ''}, then paste it here.`);
        if (flags.browser !== false && process.stdout.isTTY) openBrowser(page);
        token = await U.ask('Access token:', { hidden: true });
      }
      token = String(token || '').trim();
      if (!TOKEN_RE.test(token)) U.fail('That does not look like a StitchDB access token (it starts with sdb_pat_).');
      const projects = await api.get('/projects', { token });
      C.saveCredentials({ ...C.readCredentials(), access_token: token, api_url: C.apiUrl() === 'https://stitchdb.com' ? undefined : C.apiUrl() });
      U.ok(`Logged in. You can access ${projects.length} project${projects.length === 1 ? '' : 's'}.`);
      return { ok: true, projects: projects.length };
    },
  },
  logout: {
    group: 'Account', summary: 'Remove the stored access token',
    async run() {
      const had = C.removeCredentials();
      U.ok(had ? 'Logged out (the token is still valid until you revoke it in the dashboard).' : 'You were not logged in.');
      return { ok: true };
    },
  },

  'projects list': {
    group: 'Projects', summary: 'List the projects you can access',
    async run() {
      const list = await api.get('/projects');
      U.output(list, (rows) => U.table(['REF', 'NAME', 'STATUS', 'REGION', 'ROLE'], rows.filter((p) => !p.parent_ref).map((p) => [p.ref, p.name, p.status, p.region, p.role || ''])));
      return list;
    },
  },
  'projects api-keys': {
    group: 'Projects', summary: 'Show the API URL and keys of a project',
    async run({ flags }) {
      const ref = C.targetRef(flags, C.project(flags, { required: false }));
      const [p, keys] = await Promise.all([api.get(`/projects/${ref}`), api.get(`/projects/${ref}/api-keys`)]);
      U.output({ api_url: p.api_url, keys }, () => { U.log(`${U.c.bold('API URL')}  ${p.api_url}`); U.table(['NAME', 'KEY'], keys.map((k) => [k.name, k.api_key])); });
      return { api_url: p.api_url, keys };
    },
  },
  link: {
    group: 'Projects', summary: 'Link this folder to a StitchDB project',
    usage: '--project-ref <ref>',
    description: 'Remote commands (db push, functions deploy, gen types --linked, ...) then work on that project.',
    async run({ flags }) {
      const proj = C.project(flags);
      let ref = flags.projectRef;
      if (!ref) {
        const list = (await api.get('/projects')).filter((p) => !p.parent_ref);
        if (!list.length) U.fail('Your account has no projects yet.', { hint: 'Create one at https://stitchdb.com/dashboard/projects/new' });
        U.table(['#', 'REF', 'NAME', 'REGION'], list.map((p, i) => [String(i + 1), p.ref, p.name, p.region]));
        const a = await U.ask('Project number or ref:');
        ref = /^\d+$/.test(a) ? list[Number(a) - 1]?.ref : a;
      }
      if (!/^[a-z]{16}$/.test(ref || '')) U.fail('Not a project reference.');
      const p = await api.get(`/projects/${ref}`);
      if (p.parent_ref) U.fail(`${ref} is a preview branch. Link its parent project (${p.parent_ref}) and use "stitchdb branches switch".`);
      proj.writeTemp('project-ref', ref);
      proj.writeTemp('branch-ref', null); proj.writeTemp('branch-name', null);
      U.ok(`Linked to ${p.name} (${ref}).`);
      return { ref, name: p.name };
    },
  },
  unlink: {
    group: 'Projects', summary: 'Forget the linked project',
    async run({ flags }) {
      const proj = C.project(flags);
      for (const f of ['project-ref', 'branch-ref', 'branch-name']) proj.writeTemp(f, null);
      U.ok('Unlinked.');
      return { ok: true };
    },
  },

  init: {
    group: 'Projects', summary: 'Create the stitchdb/ folder in this app',
    usage: '[--github] [--force]',
    description: 'Creates stitchdb/config.toml, migrations/, functions/ and seed.sql. With --github also .github/workflows/stitchdb.yml (preview branches per pull request).',
    options: `--github   Also write the GitHub Actions workflow
--force    Overwrite existing files`,
    flags: { github: { type: 'boolean' }, force: { type: 'boolean' } },
    async run({ flags }) {
      const root = path.resolve(flags.workdir || process.cwd());
      const dir = path.join(root, C.DIR);
      const written = [];
      const put = (file, content) => {
        if (U.exists(file) && !flags.force) return;
        U.writeFileSafe(file, content); written.push(path.relative(root, file));
      };
      const id = path.basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
      put(path.join(dir, 'config.toml'), fs.readFileSync(path.join(TEMPLATES, 'config.toml'), 'utf8').replace('__PROJECT_ID__', id));
      put(path.join(dir, 'seed.sql'), fs.readFileSync(path.join(TEMPLATES, 'seed.sql'), 'utf8'));
      put(path.join(dir, '.gitignore'), fs.readFileSync(path.join(TEMPLATES, 'gitignore'), 'utf8'));
      fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'functions'), { recursive: true });
      if (flags.github) put(path.join(root, '.github', 'workflows', 'stitchdb.yml'), fs.readFileSync(path.join(TEMPLATES, 'github-workflow.yml'), 'utf8'));
      U.output({ written }, () => {
        if (!written.length) U.ok('stitchdb/ already exists (use --force to overwrite).');
        else { U.ok('Created:'); for (const f of written) U.log('  ' + f); }
        U.log(`\nNext: ${U.c.cyan('stitchdb link --project-ref <ref>')} to connect a project, ${U.c.cyan('stitchdb start')} for local development.`);
        if (flags.github) U.log(`GitHub: add the secret ${U.c.bold('STITCHDB_ACCESS_TOKEN')} and the variable ${U.c.bold('STITCHDB_PROJECT_REF')} in your repository settings.`);
      });
      return { written };
    },
  },
};
