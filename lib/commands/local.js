// start, stop, status (local development, native runtime: no Docker)
'use strict';
const U = require('../util');
const C = require('../config');
const L = require('../local');

function printUrls(s, exclude) {
  const u = L.urls(s);
  const rows = [['API URL', u.api], ['Database URL', u.db]];
  if (!exclude.includes('studio')) rows.push(['Studio', u.studio]);
  if (!exclude.includes('functions')) rows.push(['Functions', u.functions + '/<name>']);
  if (!exclude.includes('mail')) rows.push(['Mail catcher', u.mail]);
  rows.push(['anon key', L.KEYS.anon], ['service_role key', L.KEYS.service], ['JWT secret', L.JWT_SECRET]);
  for (const [k, v] of rows) U.log(`  ${U.c.bold(k.padEnd(17))} ${v}`);
}
const info = (proj, s, exclude) => {
  const u = L.urls(s);
  return {
    project: proj.id, root: proj.root, api_url: u.api, db_url: u.db, studio_url: exclude.includes('studio') ? null : u.studio, mail_url: exclude.includes('mail') ? null : u.mail,
    functions_url: u.functions, anon_key: L.KEYS.anon, service_role_key: L.KEYS.service, jwt_secret: L.JWT_SECRET, ports: s.ports, data_dir: s.dir, excluded: exclude,
    // Same names as before, for scripts written against older versions.
    api: u.api, db: u.db, studio: u.studio, mail: u.mail, functions: u.functions,
  };
};
const STEPS = { runtime: 'Getting the local runtime…', template: 'Creating the local database (first start)…', deno: 'Getting Deno for Edge Functions…', daemon: 'Starting…' };

module.exports = {
  start: {
    group: 'Local development', summary: 'Start the local project (no Docker needed)',
    usage: '[-x <service,...>] [--eager] [--output json]',
    description: `Runs Postgres, Auth, REST, Realtime, Storage, Edge Functions, a local Studio and a mail catcher on 127.0.0.1, as plain processes.
Postgres starts right away; the other services start on their first request and stop again after ${'[local] idle_minutes'} (default 10) without requests.
Each project folder (each git worktree) is its own local project: own data, own ports (from config.toml when they are free, else picked and remembered).
Local migrations are applied; seed.sql runs on the first start. Data is kept between starts (stitchdb db reset to start over).
The first start downloads the runtime once (about 40 MB) into ~/.stitchdb/runtime. Services you can leave out: ${L.OPTIONAL.join(', ')}.`,
    options: `-x, --exclude <list>   Services to leave out, comma separated
--eager                Start every service now and keep them running
--output json          Print the URLs, keys and database URL as JSON (same as --json)`,
    examples: `stitchdb start
stitchdb start --output json
stitchdb start -x realtime,storage,mail`,
    flags: { exclude: { type: 'array', alias: 'x' }, eager: { type: 'boolean' }, ignoreHealthCheck: { type: 'boolean' } },
    async run({ flags }) {
      const proj = C.project(flags);
      const exclude = flags.exclude || [];
      for (const x of exclude) if (!L.OPTIONAL.includes(x)) U.fail(`Unknown service "${x}". You can leave out: ${L.OPTIONAL.join(', ')}.`);
      const sp = U.spinner('Starting the local project…');
      let r;
      try { r = await L.start(proj, { exclude, eager: !!flags.eager, onStep: (k) => sp.text(STEPS[k] || 'Starting…') }); }
      finally { sp.stop(); }
      const { s, fresh, moved } = r;
      L.syncMigrations(proj, s, { seed: fresh });
      if (moved) U.warn(`The ports in config.toml are in use (another local project or app), so this folder uses ${s.ports.api}–${s.ports.smtp}. They are remembered for this folder.`);
      const out = info(proj, s, exclude);
      U.output(out, () => { U.ok(`StitchDB is running locally (${proj.id}).\n`); printUrls(s, exclude); U.log(`\nStop it with ${U.c.cyan('stitchdb stop')}.`); });
      return out;
    },
  },
  stop: {
    group: 'Local development', summary: 'Stop the local project (data is kept)',
    usage: '[--no-backup] [--all]',
    options: `--no-backup   Also delete the local data (database and files)
--all         Stop every local project on this machine`,
    flags: { backup: { type: 'boolean' }, all: { type: 'boolean' } },
    async run({ flags }) {
      if (flags.all) {
        const list = L.allProjects().filter((p) => p.running);
        for (const p of list) await L.stop({ id: p.project, root: p.root, cfg: {} }, {});
        U.ok(list.length ? `Stopped ${list.length} local project${list.length === 1 ? '' : 's'}.` : 'Nothing is running.');
        return { stopped: list.map((p) => p.root) };
      }
      const proj = C.project(flags);
      const st = await L.status(proj);
      if (!st.running && flags.backup !== false) { U.ok('Nothing is running.'); return { stopped: false }; }
      await L.stop(proj, { forget: flags.backup === false });
      U.ok(flags.backup === false ? 'Stopped and deleted the local data.' : 'Stopped. Your local data is kept for the next start.');
      return { stopped: true, data_deleted: flags.backup === false };
    },
  },
  status: {
    group: 'Local development', summary: 'Show local services, URLs and keys',
    usage: '[--all] [--output json]',
    options: '--all   Every local project on this machine (one per project folder / worktree)',
    flags: { all: { type: 'boolean' } },
    async run({ flags }) {
      if (flags.all) {
        const list = L.allProjects();
        U.output(list, (rows) => (rows.length ? U.table(['PROJECT', 'STATE', 'API', 'FOLDER'], rows.map((p) => [p.project, p.running ? U.c.green('running') : U.c.dim('stopped'), p.api, p.root])) : U.log('No local projects yet.')));
        return list;
      }
      const proj = C.project(flags);
      const st = await L.status(proj);
      const out = { running: st.running, services: st.services, memory_mb: st.memory_mb, ...(st.running ? info(proj, st.s, st.exclude) : {}) };
      U.output(out, () => {
        if (!st.running) { U.log('The local project is not running. Start it with ' + U.c.cyan('stitchdb start') + '.'); return; }
        U.table(['SERVICE', 'STATE'], st.services.map((x) => [L.LABEL[x.service] || x.service, x.state === 'running' ? U.c.green(x.state) : U.c.dim(x.state === 'sleeping' ? 'sleeping (starts on the first request)' : x.state)]));
        U.log('');
        printUrls(st.s, st.exclude);
      });
      return out;
    },
  },
};
