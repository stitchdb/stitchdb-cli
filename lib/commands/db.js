// migration new|list|repair|up, db push|pull|diff|reset|dump|query
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('../util');
const C = require('../config');
const api = require('../api');
const M = require('../migrations');
const L = require('../local');
const { diff } = require('../diff');

const BATCH = 6 * 1024 * 1024;
async function remoteDump(ref, { dataOnly = false, schemas } = {}) {
  const res = await api.request('GET', `/projects/${ref}/database/dump`, { raw: true, query: { data_only: dataOnly ? 1 : undefined, schemas: schemas?.join(',') } });
  const text = await res.text();
  if (/\n-- ERROR: the dump did not finish/.test(text)) U.fail('The dump did not finish: ' + text.split('-- ERROR: ').pop().trim());
  return text;
}
function localRunning(proj) {
  const st = L.status(proj);
  if (!st.running) U.fail('The local stack is not running.', { hint: 'Run "stitchdb start" first.' });
  return st.s;
}
const label = (m) => `${m.version}${m.name ? '_' + m.name : ''}`;
const statusText = { pending: U.c.yellow('pending'), applied: U.c.green('applied'), changed: U.c.red('changed locally'), remote_only: U.c.cyan('only on the database') };

async function push(ref, proj, { dryRun, yes }) {
  const local = M.readLocal(proj.migrationsDir);
  if (!local.length) { U.ok('No migrations in stitchdb/migrations.'); return { applied: [], pending: [] }; }
  const remote = await api.get(`/projects/${ref}/migrations`);
  const { pending, mismatched, rows } = M.plan(local, remote);
  if (mismatched.length) {
    U.fail(`${mismatched.map(label).join(', ')} ${mismatched.length === 1 ? 'was' : 'were'} already applied with different SQL.`, {
      hint: 'Applied migrations must not change. Restore the file, and put the change in a new migration ("stitchdb migration new <name>").' });
  }
  const remoteOnly = rows.filter((r) => r.status === 'remote_only');
  if (remoteOnly.length) U.warn(`The database has ${remoteOnly.length} migration${remoteOnly.length === 1 ? '' : 's'} you don't have locally (${remoteOnly.map(label).join(', ')}). Run "stitchdb db pull" to fetch ${remoteOnly.length === 1 ? 'it' : 'them'}.`);
  if (!pending.length) { U.ok('The database is up to date.'); return { applied: [], pending: [] }; }
  U.log(`${pending.length} migration${pending.length === 1 ? '' : 's'} to apply to ${ref}:`);
  for (const m of pending) U.log('  • ' + label(m));
  if (dryRun) return { applied: [], pending: pending.map(({ version, name }) => ({ version, name })), dry_run: true };
  if (!U.state.json && !(await U.confirm('Apply them now?', { yes, def: true }))) U.fail('Cancelled.', { code: 2 });
  const applied = [];
  // Batches under the request size limit; each migration still runs in its own transaction.
  for (let i = 0; i < pending.length;) {
    const batch = []; let size = 0;
    while (i < pending.length && (!batch.length || size + pending[i].sql.length < BATCH)) { size += pending[i].sql.length; batch.push(pending[i++]); }
    const sp = U.spinner(`Applying ${batch.map(label).join(', ')}…`);
    const r = await api.post(`/projects/${ref}/migrations`, { migrations: batch.map(({ version, name, sql }) => ({ version, name, sql })) }).finally(() => sp.stop());
    for (const a of r.applied) { applied.push(a); U.ok(`Applied ${label(a)} (${a.duration_ms} ms)`); }
    if (r.failed) {
      const f = r.failed;
      U.fail(`Migration ${label(f)} failed: ${f.error}${f.detail ? `\n${f.detail}` : ''}`, { hint: (f.hint ? f.hint + '\n' : '') + `Nothing from ${label(f)} was applied${applied.length ? ` (the ${applied.length} before it were)` : ''}. Fix the file and run "stitchdb db push" again.` });
    }
  }
  U.ok(`Done: ${applied.length} migration${applied.length === 1 ? '' : 's'} applied.`);
  return { applied };
}

module.exports = {
  'migration new': {
    group: 'Migrations', summary: 'Create a new empty migration file',
    usage: '<name>',
    description: 'Creates stitchdb/migrations/<timestamp>_<name>.sql. Write the SQL in it, then "stitchdb db push" (or restart the local stack).',
    examples: 'stitchdb migration new create_todos\ncat change.sql | stitchdb migration new add_index --stdin',
    flags: { stdin: { type: 'boolean' } },
    async run({ flags, args }) {
      const proj = C.project(flags);
      const sql = flags.stdin ? fs.readFileSync(0, 'utf8') : '';
      const m = M.create(proj.migrationsDir, args.join('_'), sql);
      U.ok(`Created ${U.rel(m.file)}`);
      return { version: m.version, name: m.name, file: m.file };
    },
  },
  'migration list': {
    group: 'Migrations', summary: 'Compare local migration files with a database',
    usage: '[--local]',
    options: '--local   Compare with the local database (default: the linked project)',
    flags: { local: { type: 'boolean' } },
    async run({ flags }) {
      const proj = C.project(flags);
      const local = M.readLocal(proj.migrationsDir);
      const remote = flags.local ? L.localHistory(localRunning(proj)) : await api.get(`/projects/${C.targetRef(flags, proj)}/migrations`);
      const { rows } = M.plan(local, remote);
      U.output(rows, () => U.table(['VERSION', 'NAME', 'STATUS', 'APPLIED'], rows.map((r) => [r.version, r.name, statusText[r.status], r.applied_at ? U.ago(r.applied_at) : ''])));
      return rows;
    },
  },
  'migration repair': {
    group: 'Migrations', summary: 'Mark a migration as applied or reverted without running it',
    usage: '<version> --status applied|reverted [--local]',
    description: 'Fixes the migration history when it no longer matches the database (for example after a change made by hand).',
    flags: { status: { type: 'string' }, local: { type: 'boolean' } },
    async run({ flags, args }) {
      const proj = C.project(flags);
      const version = args[0];
      if (!/^\d+$/.test(version || '')) U.fail('Give the migration version, for example: stitchdb migration repair 20261019120000 --status applied');
      if (!['applied', 'reverted'].includes(flags.status)) U.fail('--status must be applied or reverted');
      const file = M.readLocal(proj.migrationsDir).find((m) => m.version === version);
      if (flags.status === 'applied' && !file) U.fail(`No local file for ${version}.`);
      if (flags.local) {
        const s = localRunning(proj);
        L.localHistory(s);
        if (flags.status === 'reverted') L.psql(s, `delete from stitchdb_migrations.schema_migrations where version = '${version}';`);
        else L.psql(s, `insert into stitchdb_migrations.schema_migrations (version, name, checksum, statements, applied_by) values ('${version}', '${file.name}', '${file.checksum}', '', 'repair') on conflict (version) do update set checksum = excluded.checksum;`);
      } else {
        await api.post(`/projects/${C.targetRef(flags, proj)}/migrations/repair`, { version, status: flags.status, name: file?.name, sql: file?.sql || '' });
      }
      U.ok(`Marked ${version} as ${flags.status}.`);
      return { version, status: flags.status };
    },
  },
  'migration up': {
    group: 'Migrations', summary: 'Apply pending migrations to the local database',
    async run({ flags }) {
      const proj = C.project(flags);
      const s = localRunning(proj);
      const n = L.syncMigrations(proj, s, { seed: false });
      if (!n) U.ok('The local database is up to date.');
      return { applied: n };
    },
  },

  'db push': {
    group: 'Database', summary: 'Apply local migrations to the linked project (or a branch)',
    usage: '[--dry-run]',
    description: 'Runs every migration the database does not have yet, in order, each in its own transaction. Stops at the first error.',
    options: '--dry-run   Only list what would be applied',
    examples: 'stitchdb db push\nstitchdb db push --project-ref <branch ref> --yes   # CI',
    flags: { dryRun: { type: 'boolean' } },
    async run({ flags }) {
      const proj = C.project(flags);
      return push(C.targetRef(flags, proj), proj, { dryRun: flags.dryRun, yes: flags.yes });
    },
  },
  'db pull': {
    group: 'Database', summary: 'Bring changes made on the database into local migration files',
    usage: '[name]',
    description: `1. Downloads migrations the database has but this folder doesn't.
2. Database without any migration history: writes its current schema as the first migration.
3. Otherwise (needs Docker): compares the database with your migrations and writes the difference as a new migration.
New migrations are recorded as applied on the database, so "db push" won't run them there again.`,
    async run({ flags, args }) {
      const proj = C.project(flags);
      const ref = C.targetRef(flags, proj);
      const remote = await api.get(`/projects/${ref}/migrations`, { query: { include_sql: 1 } });
      const local = M.readLocal(proj.migrationsDir);
      const have = new Set(local.map((m) => m.version));
      const fetched = [];
      for (const r of remote) {
        if (have.has(r.version)) continue;
        const file = path.join(proj.migrationsDir, `${r.version}${r.name ? '_' + r.name : ''}.sql`);
        U.writeFileSafe(file, r.sql || ''); fetched.push(file); U.ok(`Fetched ${U.rel(file)}`);
      }
      const name = M.slug(args.join('_') || (remote.length ? 'remote_changes' : 'remote_schema'));
      const record = async (m) => {
        try { await api.post(`/projects/${ref}/migrations/repair`, { version: m.version, status: 'applied', name: m.name, sql: m.sql }); }
        catch (e) { U.warn(`Could not record ${label(m)} as applied on the database (${e.message}). Run "stitchdb migration repair ${m.version} --status applied" later.`); }
      };
      if (!remote.length) {
        const dump = await remoteDump(ref);
        if (!/^CREATE /m.test(dump)) { U.ok('The database has no schema of its own yet: nothing to pull.'); return { fetched: fetched.length, created: null }; }
        const m = M.create(proj.migrationsDir, name, dump);
        await record({ ...m, sql: dump });
        U.ok(`Wrote the current schema to ${U.rel(m.file)}`);
        return { fetched: fetched.length, created: m.file };
      }
      if (!L.dockerAvailable()) {
        U.warn('Docker is not available: only the migration history was compared. Install Docker to also detect changes made outside migrations.');
        return { fetched: fetched.length, created: null };
      }
      const sp = U.spinner('Comparing the database with your migrations (starts a temporary database)…');
      const sql = await L.withShadow(M.readLocal(proj.migrationsDir), async (sh) => diff(sh.dump(), await remoteDump(ref))).finally(() => sp.stop());
      if (!sql) { U.ok('No changes outside migrations.'); return { fetched: fetched.length, created: null }; }
      const m = M.create(proj.migrationsDir, name, sql + '\n');
      await record({ ...m, sql: sql + '\n' });
      U.ok(`Wrote the changes to ${U.rel(m.file)} — review it.`);
      return { fetched: fetched.length, created: m.file };
    },
  },
  'db diff': {
    group: 'Database', summary: 'Show schema changes not captured in migrations',
    usage: '[--linked] [-f <name>]',
    description: `Builds a temporary database from your migrations (Docker) and compares it with the local database (default) or the linked project (--linked).
The output is SQL; with -f it is saved as a new migration.`,
    options: `--linked         Compare with the linked project instead of the local database
-f, --file <name>  Save the SQL as a new migration`,
    flags: { linked: { type: 'boolean' }, file: { type: 'string', alias: 'f' }, schema: { type: 'array', alias: 's' } },
    async run({ flags }) {
      L.requireDocker();
      const proj = C.project(flags);
      const target = flags.linked || flags.projectRef ? { ref: C.targetRef(flags, proj) } : { s: localRunning(proj) };
      const sp = U.spinner('Comparing (starts a temporary database with your migrations)…');
      const sql = await L.withShadow(M.readLocal(proj.migrationsDir), async (sh) => diff(sh.dump(), target.ref ? await remoteDump(target.ref, { schemas: flags.schema }) : L.dumpLocal(target.s, { schemas: flags.schema })))
        .finally(() => sp.stop());
      if (!sql) { U.ok('No schema changes.'); return { sql: '' }; }
      if (flags.file) {
        const m = M.create(proj.migrationsDir, flags.file, sql + '\n');
        // The local database already has these changes: record the new migration there so "start" won't re-run it.
        if (target.s) L.psql(target.s, `insert into stitchdb_migrations.schema_migrations (version, name, checksum, statements, applied_by) values ('${m.version}', '${m.name}', '${M.checksum(sql + '\n')}', '', 'diff') on conflict do nothing;`);
        U.ok(`Saved ${U.rel(m.file)}`);
        return { sql, file: m.file };
      }
      if (!U.state.json) process.stdout.write(sql + '\n');
      return { sql };
    },
  },
  'db reset': {
    group: 'Database', summary: 'Recreate the local database from migrations and seed.sql',
    description: 'Deletes the local database and files, starts again, applies every migration and runs seed.sql. Never touches your projects on StitchDB.',
    async run({ flags }) {
      const proj = C.project(flags);
      const st = L.status(proj);
      let exclude = [];
      try { exclude = JSON.parse(fs.readFileSync(path.join(st.s.dir, 'exclude.json'), 'utf8')); } catch {}
      if (!(await U.confirm('Delete all local data and rebuild it from your migrations?', { yes: flags.yes, def: true }))) U.fail('Cancelled.', { code: 2 });
      if (st.services.length) L.dc(st.s, ['down', '-v']);
      return require('./local').start.run({ flags: { ...flags, exclude } });
    },
  },
  'db dump': {
    group: 'Database', summary: 'Dump the schema (or data) of a database as SQL',
    usage: '[-f <file>] [--data-only] [--schema <list>] [--local]',
    options: `-f, --file <file>   Write to a file instead of stdout
--data-only         Rows only (COPY statements), no schema
-s, --schema <list> Only these schemas (default: all of yours)
--local             Dump the local database`,
    flags: { file: { type: 'string', alias: 'f' }, dataOnly: { type: 'boolean' }, schema: { type: 'array', alias: 's' }, local: { type: 'boolean' } },
    async run({ flags }) {
      const proj = C.project(flags, { required: !!flags.local });
      const text = flags.local ? L.dumpLocal(localRunning(proj), { dataOnly: flags.dataOnly, schemas: flags.schema })
        : await remoteDump(C.targetRef(flags, proj), { dataOnly: flags.dataOnly, schemas: flags.schema });
      if (flags.file) { U.writeFileSafe(path.resolve(flags.file), text); U.ok(`Wrote ${flags.file} (${Math.round(text.length / 1024)} KB)`); return { file: flags.file, bytes: text.length }; }
      process.stdout.write(text);
      return undefined;
    },
  },
  'db query': {
    group: 'Database', summary: 'Run SQL on the linked project (or the local database)',
    usage: '"<sql>" | -f <file> [--local] [--read-only]',
    flags: { file: { type: 'string', alias: 'f' }, local: { type: 'boolean' }, readOnly: { type: 'boolean' } },
    examples: `stitchdb db query "select count(*) from public.todos"
stitchdb db query -f report.sql --json`,
    async run({ flags, args }) {
      const sql = flags.file ? fs.readFileSync(flags.file, 'utf8') : args.join(' ');
      if (!sql.trim()) U.fail('Give the SQL to run, or -f <file>.');
      if (flags.local) {
        const proj = C.project(flags);
        const s = localRunning(proj);
        const rows = /^\s*(select|with|values|table|show|explain)\b/i.test(sql) && !/;\s*\S/.test(sql.trim().replace(/;\s*$/, '')) ? L.queryJson(s, sql) : (process.stdout.write(L.psql(s, sql)), null);
        if (rows) U.output(rows, (r) => (r.length ? U.table(Object.keys(r[0]), r.map((x) => Object.values(x).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)))) : U.log(U.c.dim('(no rows)'))));
        return rows || undefined;
      }
      const proj = C.project(flags, { required: false });
      const r = await api.post(`/projects/${C.targetRef(flags, proj)}/database/query`, { query: sql, read_only: !!flags.readOnly });
      U.output(r.rows, (rows) => {
        const last = r.results.at(-1);
        if (rows.length) U.table(last.columns, rows.map((x) => last.columns.map((k) => (x[k] !== null && typeof x[k] === 'object' ? JSON.stringify(x[k]) : x[k]))));
        else U.log(U.c.dim(`${last?.command || 'OK'}${last?.row_count != null ? ` ${last.row_count}` : ''}`));
        if (last?.truncated) U.warn('Showing the first rows only.');
      });
      return r.rows;
    },
  },
};
