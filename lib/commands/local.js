// start, stop, status (local development stack)
'use strict';
const fs = require('fs');
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
const info = (s, exclude) => ({ ...L.urls(s), anon_key: L.KEYS.anon, service_role_key: L.KEYS.service, jwt_secret: L.JWT_SECRET, excluded: exclude });

module.exports = {
  start: {
    group: 'Local development', summary: 'Start the local development stack (Docker)',
    usage: '[-x <service,...>] [--ignore-health-check]',
    description: `Starts Postgres, Auth, REST, Realtime, Storage, Edge Functions, a local Studio and a mail catcher on 127.0.0.1.
Local migrations are applied; seed.sql runs on the first start. Data is kept between starts (stitchdb db reset to start over).
Services you can leave out: ${L.OPTIONAL.join(', ')}.`,
    options: `-x, --exclude <list>     Services to leave out, comma separated
--ignore-health-check    Don't wait for the services to be ready`,
    examples: `stitchdb start
stitchdb start -x realtime,storage,mail`,
    flags: { exclude: { type: 'array', alias: 'x' }, ignoreHealthCheck: { type: 'boolean' } },
    async run({ flags }) {
      L.requireDocker();
      const proj = C.project(flags);
      const exclude = flags.exclude || [];
      for (const x of exclude) if (!L.OPTIONAL.includes(x)) U.fail(`Unknown service "${x}". You can leave out: ${L.OPTIONAL.join(', ')}.`);
      const s = L.settings(proj);
      const fresh = !L.status(proj).services.some((x) => x.service === 'db');
      L.writeStack(proj, s, exclude);
      const sp = U.spinner(fresh ? 'Starting the local stack (the first start downloads the images, this can take a few minutes)…' : 'Starting the local stack…');
      try {
        L.dc(s, ['up', '-d', '--remove-orphans', '--quiet-pull']);
        // Config files are bind-mounted: a changed gateway.conf / functions.json only applies after a restart.
        if (!fresh) L.dc(s, ['restart', 'gateway', ...(exclude.includes('functions') ? [] : ['functions'])]);
      } catch (e) { sp.stop(); throw e; }
      sp.text('Waiting for the database…');
      await L.waitDb(s);
      sp.stop();
      L.syncMigrations(proj, s, { seed: fresh });
      if (!flags.ignoreHealthCheck) { const w = U.spinner('Waiting for the services…'); await L.waitHealthy(s, exclude); w.stop(); }
      U.output(info(s, exclude), () => { U.ok(`StitchDB is running locally (${proj.id}).\n`); printUrls(s, exclude); U.log(`\nStop it with ${U.c.cyan('stitchdb stop')}.`); });
      return info(s, exclude);
    },
  },
  stop: {
    group: 'Local development', summary: 'Stop the local stack (data is kept)',
    usage: '[--no-backup]',
    options: '--no-backup   Also delete the local data (database and files)',
    flags: { backup: { type: 'boolean' } },
    async run({ flags }) {
      const proj = C.project(flags);
      const st = L.status(proj);
      const hasStack = require('fs').existsSync(require('path').join(st.s.dir, 'docker-compose.yml'));
      if (!st.services.length && !(flags.backup === false && hasStack)) { U.ok('Nothing is running.'); return { stopped: false }; }
      L.dc(st.s, ['down', ...(flags.backup === false ? ['-v'] : [])]);
      U.ok(flags.backup === false ? 'Stopped and deleted the local data.' : 'Stopped. Your local data is kept for the next start.');
      return { stopped: true, data_deleted: flags.backup === false };
    },
  },
  status: {
    group: 'Local development', summary: 'Show local services, URLs and keys',
    async run({ flags }) {
      const proj = C.project(flags);
      const st = L.status(proj);
      let exclude = [];
      try { exclude = JSON.parse(fs.readFileSync(require('path').join(st.s.dir, 'exclude.json'), 'utf8')); } catch {}
      const out = { running: st.running, services: st.services, ...(st.running ? info(st.s, exclude) : {}) };
      U.output(out, () => {
        if (!st.services.length) { U.log('The local stack is not running. Start it with ' + U.c.cyan('stitchdb start') + '.'); return; }
        U.table(['SERVICE', 'STATE', 'HEALTH'], st.services.map((x) => [L.LABEL[x.service] || x.service, x.state === 'running' ? U.c.green(x.state) : U.c.yellow(x.state), x.health]));
        if (st.running) { U.log(''); printUrls(st.s, exclude); }
      });
      return out;
    },
  },
};
