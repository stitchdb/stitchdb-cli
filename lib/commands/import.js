// import | import status | import switch-over | import undo: copy another Postgres database into a StitchDB project
// (the migration wizard of the dashboard: Database → Import from Postgres). The copy runs on the project's server.
'use strict';
const fs = require('fs');
const U = require('../util');
const C = require('../config');
const api = require('../api');

const size = (b) => (b == null ? '—' : b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1024 ** 3 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const MODE = { live: 'live copy', dump: 'one-time copy' };
const BUSY = ['waiting', 'checking', 'copying', 'switching', 'undoing'];
const refOf = (flags) => C.targetRef(flags, C.project(flags, { required: false }), { allowBranch: false });

async function wait(ref, done, text) {
  const sp = U.spinner(text);
  try {
    for (;;) {
      const st = await api.get(`/projects/${ref}/import`);
      if (st.steps && st.state !== 'syncing') sp.text(`${st.steps[st.step] || text}${st.progress?.files_total ? ` (files ${num(st.progress.files)}/${num(st.progress.files_total)})` : ''}…`);
      if (st.state === 'syncing' && st.progress) sp.text(`Live copy: ${num(st.progress.tables_ready)} of ${num(st.progress.tables)} tables, ${size(st.progress.lag_bytes)} behind…`);
      if (done(st)) return st;
      await U.sleep(2000);
    }
  } finally { sp.stop(); }
}
function printReport(r) {
  U.log(`  Source       Postgres ${r.source?.version || ''}, ${size(r.source?.db_bytes)}`);
  U.log(`  Schemas      ${r.schemas.join(', ')}`);
  U.log(`  Tables       ${num(r.tables)} (about ${num(r.rows)} rows)`);
  if (r.auth_users != null) U.log(`  Auth users   ${num(r.auth_users)}`);
  if (r.objects != null) U.log(`  Files        ${num(r.objects)} (${size(r.objects_bytes)})${r.files ? '' : U.c.dim(' not copied: pass --storage-url and --storage-key')}`);
  if (r.cron_jobs != null) U.log(`  Cron jobs    ${num(r.cron_jobs)}`);
  U.log(`  How          ${MODE[r.mode]}`);
  for (const n of r.notes || []) U.warn(n);
  if (r.platform?.functions?.length) U.info(`Deploy your Edge Functions afterwards: ${r.platform.functions.map((f) => f.slug).join(', ')} (stitchdb functions deploy)`);
}
function printResult(st) {
  const r = st.result || {}, bad = (r.tables || []).filter((t) => !t.ok);
  U.ok(`Imported: ${num(r.tables_ok)} tables match${bad.length ? U.c.red(`, ${bad.length} differ`) : ''}, ${num(r.auth_users)} auth users, ${num(r.files)} files, ${num(r.cron_jobs)} cron jobs.`);
  if (bad.length) U.table(['TABLE', 'SOURCE', 'HERE'], bad.map((t) => [t.table, num(t.source_rows), num(t.target_rows)]));
  for (const w of (st.warnings || []).slice(0, 20)) U.warn(w);
  if (st.job?.applied?.settings?.length) U.ok(`Auth settings applied: ${st.job.applied.settings.join(', ')}`);
  U.log(`\nNext: use this project's URL and keys in your app (users keep their passwords), deploy functions with ${U.c.cyan('stitchdb functions deploy')}, set provider keys again.`);
}

module.exports = {
  import: {
    group: 'Database', summary: 'Copy another Postgres database (another platform or your own server) into a project',
    usage: '[connection string] [--mode auto|live|dump] [--storage-url <url> --storage-key <key>] [--platform-token <token>] [--secrets <.env file>]',
    description: `Copies schemas, data, policies, functions, auth users with their password hashes, buckets and files, cron jobs and
realtime tables into the project (it must be empty: create a new project for it). The connection string can also come
from STITCHDB_IMPORT_SOURCE, or is asked for. Use the source's direct connection (port 5432).

Live copy (default when the source allows it: wal_level = logical and a REPLICATION login): the source keeps running,
the project follows its changes, and you switch over in seconds with "stitchdb import switch-over".
One-time copy (--mode dump): stop writes to the source first.`,
    options: `--mode <m>              auto (default), live or dump
--storage-url <url>     The source's API URL, to copy stored files (with --storage-key)
--storage-key <key>     The source's service role key
--platform-token <t>    Access token of the platform the source runs on: reads its Auth settings
--secrets <file>        A .env file of Edge Function secrets to set on the project
--no-auth-settings      Don't apply the Auth settings read with --platform-token
--no-wait               Start and return; follow with "stitchdb import status"`,
    flags: { mode: { type: 'string' }, storageUrl: { type: 'string' }, storageKey: { type: 'string' }, platformToken: { type: 'string' }, secrets: { type: 'string' }, authSettings: { type: 'boolean' }, wait: { type: 'boolean' } },
    async run({ flags, args }) {
      const ref = refOf(flags);
      if (flags.mode && !['auto', 'live', 'dump'].includes(flags.mode)) U.fail('--mode is auto, live or dump.');
      const secrets = flags.secrets ? fs.readFileSync(flags.secrets, 'utf8') : '';
      const source = args[0] || process.env.STITCHDB_IMPORT_SOURCE || await U.ask('Connection string of the source database:', { hidden: true });
      await api.post(`/projects/${ref}/import`, { source_uri: source, mode: flags.mode || 'auto', storage_url: flags.storageUrl || null,
        storage_key: flags.storageKey || process.env.STITCHDB_IMPORT_STORAGE_KEY || null, api_token: flags.platformToken || process.env.STITCHDB_IMPORT_PLATFORM_TOKEN || null });
      let st = await wait(ref, (s) => !BUSY.includes(s.state), 'Checking the source');
      if (st.state === 'blocked') U.fail(`The source cannot be imported yet:\n  ${(st.report?.blockers || [st.error]).join('\n  ')}`);
      printReport(st.report);
      if (U.state.json && !flags.yes) return st;
      if (!(await U.confirm(`Start the ${MODE[st.report.mode]} into ${ref}?`, { yes: flags.yes, def: true }))) U.fail('Cancelled. The check is kept; start again any time.', { code: 2 });
      await api.post(`/projects/${ref}/import/copy`, { secrets, auth: flags.authSettings !== false });
      if (flags.wait === false) { U.ok(`Copy started. Follow it with ${U.c.cyan('stitchdb import status')}.`); return { started: true }; }
      st = await wait(ref, (s) => !s.running && !BUSY.includes(s.state) && (s.state !== 'syncing' || (s.progress && s.progress.tables_ready === s.progress.tables)), 'Copying');
      if (st.state === 'failed') U.fail(`The import stopped: ${st.error}`, { hint: 'Run "stitchdb import undo" and try again.' });
      if (st.state === 'syncing') {
        U.ok(`Live copy running: every table copied, now following changes (${size(st.progress.lag_bytes)} behind).`);
        U.log(`When you are ready: point your app at this project, stop writes to the old database, then run ${U.c.cyan('stitchdb import switch-over')}.`);
        return st;
      }
      printResult(st);
      return st;
    },
  },
  'import status': {
    group: 'Database', summary: 'Show the import of the project (check, copy progress, live copy lag, result)',
    async run({ flags }) {
      const ref = refOf(flags);
      const st = await api.get(`/projects/${ref}/import`);
      if (!st.job) { U.info('No import for this project.'); return st; }
      U.log(`${U.c.bold(st.job.source || '')}  ${st.state}${st.running ? ` (${st.running})` : ''}`);
      if (st.state === 'checked' || st.state === 'blocked') printReport(st.report || {});
      if (st.state === 'blocked') for (const b of st.report?.blockers || []) U.warn(b);
      if (st.steps && BUSY.includes(st.state)) U.log(`  Step ${st.step + 1}/${st.steps.length}: ${st.steps[st.step]}`);
      if (st.state === 'syncing' && st.progress) U.log(`  Tables ${num(st.progress.tables_ready)}/${num(st.progress.tables)} copied, ${size(st.progress.lag_bytes)} behind the source`);
      if (st.error) U.warn(st.error);
      if (st.state === 'done') printResult(st);
      return st;
    },
  },
  'import switch-over': {
    group: 'Database', summary: 'Finish a live copy: last changes, sequences, auth users, files, then check everything',
    async run({ flags }) {
      const ref = refOf(flags);
      if (!(await U.confirm('Writes made to the old database after this are not copied. Have you stopped them?', { yes: flags.yes }))) U.fail('Cancelled.', { code: 2 });
      await api.post(`/projects/${ref}/import/cutover`, {});
      const st = await wait(ref, (s) => !s.running && !BUSY.includes(s.state), 'Switching over');
      if (st.state === 'syncing') U.fail(st.error || 'The live copy has not caught up yet.', { hint: 'Try again in a moment.' });
      if (st.state === 'failed') U.fail(`The switch-over stopped: ${st.error}`);
      printResult(st);
      return st;
    },
  },
  'import undo': {
    group: 'Database', summary: 'Remove everything an import added to the project (the source is not changed)',
    async run({ flags }) {
      const ref = refOf(flags);
      const p = await api.get(`/projects/${ref}`);
      const name = flags.yes ? p.name : await U.ask(`Type the project name (${p.name}) to remove everything the import added:`);
      if (name !== p.name && name !== ref) U.fail('The name does not match. Nothing was changed.', { code: 2 });
      await api.post(`/projects/${ref}/import/undo`, { confirm: name });
      const st = await wait(ref, (s) => !s.running && !BUSY.includes(s.state), 'Undoing the import');
      if (st.state !== 'undone') U.fail(`Undo stopped: ${st.error || st.state}`);
      U.ok('The import was undone. The project is empty again.');
      return st;
    },
  },
};
