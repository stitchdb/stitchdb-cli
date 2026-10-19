// branches list|create|get|delete|switch|merge
'use strict';
const U = require('../util');
const C = require('../config');
const api = require('../api');

const STATUS = { ready: U.c.green('ready'), creating: U.c.yellow('creating'), failed: U.c.red('failed') };
const parentOf = (flags, proj) => C.targetRef(flags, proj, { allowBranch: false });
async function find(parent, nameOrRef) {
  const list = await api.get(`/projects/${parent}/branches`);
  return list.find((b) => b.ref === nameOrRef || b.git_branch === nameOrRef) || null;
}
async function waitReady(ref, { timeout = 15 * 60000 } = {}) {
  const t0 = Date.now();
  const sp = U.spinner('Waiting for the branch (database, schema, seed)…');
  try {
    for (;;) {
      const b = await api.get(`/branches/${ref}`);
      if (b.branch_status === 'ready' && b.status === 'active') return b;
      if (b.branch_status === 'failed') U.fail(`The branch could not be set up: ${b.error || 'unknown error'}`, { hint: 'Fix the migration, then "stitchdb branches delete" and create it again.' });
      if (Date.now() - t0 > timeout) U.fail('The branch is taking too long to get ready.');
      await U.sleep(4000);
    }
  } finally { sp.stop(); }
}

module.exports = {
  'branches list': {
    group: 'Preview branches', summary: 'List the preview branches of the linked project',
    async run({ flags }) {
      const proj = C.project(flags, { required: false });
      const parent = parentOf(flags, proj);
      const list = await api.get(`/projects/${parent}/branches`);
      U.output(list, (rows) => U.table(['BRANCH', 'REF', 'STATUS', 'CREATED', ''], rows.map((b) => [b.git_branch, b.ref,
        b.status === 'paused' ? U.c.yellow('paused') : STATUS[b.branch_status] || b.branch_status, U.ago(b.created_at), proj?.branchRef === b.ref ? U.c.cyan('← current') : ''])));
      return list;
    },
  },
  'branches create': {
    group: 'Preview branches', summary: 'Create a preview branch (its own database, URL and keys)',
    usage: '<git branch name> [--wait] [--no-seed]',
    description: `Creates a copy of the linked project's schema (from its migrations, or its current schema when it has none) and runs stitchdb/seed.sql.
Data is never copied. Auth settings are copied. Idempotent: an existing branch with that name is returned.
Pro plan: 3 branches per project, Scale: 10. Idle branches pause after a few days.`,
    options: `--wait      Wait until the branch is ready
--no-seed   Don't run seed.sql`,
    flags: { wait: { type: 'boolean' }, seed: { type: 'boolean' } },
    async run({ flags, args }) {
      const proj = C.project(flags, { required: false });
      const parent = parentOf(flags, proj);
      const name = args[0];
      if (!name) U.fail('Give the branch a name (usually your git branch).');
      let seed = '';
      if (flags.seed !== false && proj && require('fs').existsSync(proj.seedFile)) seed = require('fs').readFileSync(proj.seedFile, 'utf8');
      let b = await api.post(`/projects/${parent}/branches`, { git_branch: name, seed });
      if (b.existing) U.info(`Branch ${U.c.bold(name)} already exists (${b.ref}).`); else U.ok(`Created branch ${U.c.bold(name)} (${b.ref}).`);
      if (flags.wait) { b = await waitReady(b.ref); U.ok(`Ready: ${b.api_url}`); }
      else if (!b.existing) U.log(`It takes a minute to get ready. Follow it with ${U.c.cyan(`stitchdb branches get ${name}`)}.`);
      return b;
    },
  },
  'branches get': {
    group: 'Preview branches', summary: 'Show one branch (status, URL, keys)',
    usage: '<name|ref>',
    async run({ flags, args }) {
      const proj = C.project(flags, { required: false });
      const b = await find(parentOf(flags, proj), args[0] || proj?.branchName);
      if (!b) U.fail(`No branch "${args[0] || ''}".`);
      const keys = b.branch_status === 'ready' ? await api.get(`/projects/${b.ref}/api-keys`).catch(() => []) : [];
      const out = { ...b, keys };
      U.output(out, () => {
        for (const [k, v] of [['Branch', b.git_branch], ['Ref', b.ref], ['Status', b.status === 'paused' ? 'paused' : b.branch_status], ['API URL', b.api_url], ...keys.map((k2) => [`${k2.name} key`, k2.api_key])]) U.log(`  ${U.c.bold(k.padEnd(16))} ${v}`);
        if (b.error) U.log(`  ${U.c.bold('Error'.padEnd(16))} ${U.c.red(b.error)}`);
      });
      return out;
    },
  },
  'branches delete': {
    group: 'Preview branches', summary: 'Delete a preview branch and its database',
    usage: '<name|ref> [--if-exists]',
    flags: { ifExists: { type: 'boolean' } },
    async run({ flags, args }) {
      const proj = C.project(flags, { required: false });
      const b = await find(parentOf(flags, proj), args[0]);
      if (!b) { if (flags.ifExists) { U.ok(`No branch "${args[0]}" (nothing to delete).`); return { deleted: null }; } U.fail(`No branch "${args[0] || ''}".`); }
      if (!(await U.confirm(`Delete branch ${b.git_branch} (${b.ref}) with its database and files?`, { yes: flags.yes }))) U.fail('Cancelled.', { code: 2 });
      await api.del(`/branches/${b.ref}`);
      if (proj?.branchRef === b.ref) { proj.writeTemp('branch-ref', null); proj.writeTemp('branch-name', null); }
      U.ok(`Deleted branch ${b.git_branch}.`);
      return { deleted: b.ref };
    },
  },
  'branches switch': {
    group: 'Preview branches', summary: 'Point remote commands at a branch (or back at production)',
    usage: '<name|ref|main>',
    description: 'After "stitchdb branches switch my-feature", db push, functions deploy, gen types and db query work on that branch. "stitchdb branches switch main" goes back to the linked project.',
    async run({ flags, args }) {
      const proj = C.project(flags);
      const target = args[0];
      if (!target) U.fail('Give the branch name, or main.');
      if (['main', 'master', 'production'].includes(target)) { proj.writeTemp('branch-ref', null); proj.writeTemp('branch-name', null); U.ok(`Back on production (${proj.linkedRef || 'not linked'}).`); return { ref: proj.linkedRef }; }
      const b = await find(parentOf(flags, proj), target);
      if (!b) U.fail(`No branch "${target}".`, { hint: `Create it with "stitchdb branches create ${target}".` });
      proj.writeTemp('branch-ref', b.ref); proj.writeTemp('branch-name', b.git_branch);
      U.ok(`Remote commands now use branch ${U.c.bold(b.git_branch)} (${b.ref}).`);
      return { ref: b.ref, git_branch: b.git_branch };
    },
  },
  'branches merge': {
    group: 'Preview branches', summary: "Apply a branch's new migrations to production",
    usage: '<name|ref> [--dry-run] [--delete]',
    description: 'Runs the migrations the branch has and production does not, in order, on the production project. Data is not merged.',
    options: `--dry-run   Only list the migrations
--delete    Delete the branch afterwards`,
    flags: { dryRun: { type: 'boolean' }, delete: { type: 'boolean' } },
    async run({ flags, args }) {
      const proj = C.project(flags, { required: false });
      const parent = parentOf(flags, proj);
      const b = await find(parent, args[0] || proj?.branchName);
      if (!b) U.fail(`No branch "${args[0] || ''}".`);
      if (!flags.dryRun && !(await U.confirm(`Apply the migrations of ${b.git_branch} to production (${parent})?`, { yes: flags.yes }))) U.fail('Cancelled.', { code: 2 });
      const r = await api.post(`/branches/${b.ref}/merge`, { dry_run: !!flags.dryRun, delete: !!flags.delete });
      if (r.failed) U.fail(`Migration ${r.failed.version} failed on production: ${r.failed.error}`, { hint: 'Production is unchanged from that migration on.' });
      U.output(r, () => {
        if (r.nothing_to_merge) U.ok('Production already has every migration of this branch.');
        else if (flags.dryRun) { U.log('Would apply:'); for (const m of r.pending || []) U.log(`  • ${m.version}_${m.name}`); }
        else U.ok(`Applied ${r.applied.length} migration${r.applied.length === 1 ? '' : 's'} to production.`);
        if (r.deleted) U.ok('Deleted the branch.');
      });
      return r;
    },
  },
};
