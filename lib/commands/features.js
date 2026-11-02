// Dashboard features on the Management API (access tokens with scopes): backups and point-in-time restore, compute
// size, restart, read replicas, budget, full export / import, cron jobs, queues, rate limits, SAML SSO providers, the
// recycle bin, change history and shared views. App features (flags, inbound webhooks, status page, push, purchases,
// links, metering, monitors, crashes) are in app-settings.js.
'use strict';
const U = require('../util');
const M = require('../manage');
const F = require('../feature-cmd');
const { cmd, input, needBody, need, intArg, matchArg, enc, isoTime, tableArg, rows, show } = F;

const UUID = /^[0-9a-f-]{36}$/i;
const JOB = /^[a-f0-9]{16}$/;
const VIEW = /^sv_[0-9a-f]{16}$/;
const FILE_OPT = `--file <json>         Fields from a JSON file (key=value arguments win)
key=value             A field; dots reach nested ones (alerts.email=true); values are JSON when they look like it`;
const FILE_FLAGS = { file: { type: 'string', alias: 'f' }, set: { type: 'array' } };
const day = (d) => (d ? M.date(d) : '');

// ---------- backups ----------
const BSTATUS = { done: U.c.green('done'), ok: U.c.green('ok'), running: U.c.yellow('running'), failed: U.c.red('failed') };
const B = 'Backups';
const backups = {
  'backups list': cmd({
    group: B, summary: 'Backups of a project, the plan\'s retention and the point-in-time window',
    usage: '[ref]', method: 'GET', path: '/backups',
    show(r) {
      M.fields([['Daily backups', M.yes(r.included)], ['Retention', r.retention_days != null ? `${r.retention_days} days` : null],
        ['Point-in-time', r.pitr?.included ? `${r.pitr.days} days${r.pitr.branches ? ' (also into a branch)' : ''}` : 'no']]);
      U.log('');
      U.table(['ID', 'STATUS', 'BY', 'SIZE', 'STARTED', 'FINISHED', 'FILES'], (r.backups || []).map((b) => [String(b.id), BSTATUS[b.status] || b.status, b.by || '',
        b.size_bytes != null ? M.bytes(b.size_bytes) : '', day(b.started_at), day(b.finished_at), b.files ? 'yes' : '']));
    },
  }),
  'backups create': cmd({
    group: B, summary: 'Start a manual backup now (one per hour)',
    usage: '[ref]', method: 'POST', path: '/backups',
    done: (r) => `Backup started${r?.id ? ` (id ${r.id})` : ''}. Follow it with "stitchdb backups list".`,
  }),
  'backups restore': cmd({
    group: B, summary: 'Restore a backup (the current state is backed up first, so it can be undone)',
    usage: '[ref] <backup id> [--yes]', need: 1, method: 'POST',
    path: ({ args }) => `/backups/${intArg(args[0], 'backup id (stitchdb backups list)')}/restore`,
    confirm: ({ args, ref }) => `Restore backup ${args[0]} into ${ref}? Its database goes back to that backup (a copy of the current state is kept).`,
    done: (r) => `Restore started${r?.id ? ` (job ${r.id})` : ''}. Follow it with "stitchdb backups jobs".`,
  }),
  'backups download': cmd({
    group: B, summary: 'A signed download link of a backup (prints the URL)',
    usage: '[ref] <backup id> [--files]', need: 1, method: 'GET',
    options: '--files   The backup\'s Storage files instead of the database dump',
    flags: { files: { type: 'boolean' } },
    path: ({ args }) => `/backups/${intArg(args[0], 'backup id (stitchdb backups list)')}/download`,
    query: ({ flags }) => ({ files: flags.files ? '1' : undefined }),
    show: (r) => { U.log(r.url); if (r.expires_in) U.log(U.c.dim(`  Valid for ${Math.round(r.expires_in / 60)} minutes.`)); },
  }),
  'backups export': cmd({
    group: B, summary: 'A signed link that streams a fresh dump of the current data (prints the URL)',
    usage: '[ref]', method: 'POST', path: '/backups/export',
    examples: 'curl -o dump.sql.gz "$(stitchdb backups export --json | jq -r .url)"',
    show: (r) => { U.log(r.url); if (r.expires_in) U.log(U.c.dim(`  Valid for ${Math.round(r.expires_in / 60)} minutes.`)); },
  }),
  'backups pitr': cmd({
    group: B, summary: 'Point-in-time recovery: the window you can restore to',
    usage: '[ref]', method: 'GET', path: '/backups/pitr',
    show(r) {
      M.fields([['Included', M.yes(r.included)], ['Days', r.days], ['Earliest', day(r.earliest)], ['Latest', day(r.latest)],
        ['Restore takes about', r.restore_estimate_seconds ? `${Math.ceil(r.restore_estimate_seconds / 60)} min` : null]]);
      if ((r.ranges || []).length > 1) { U.log(''); U.table(['FROM', 'TO'], r.ranges.map((x) => [day(x.from), day(x.to)])); }
    },
  }),
  'backups restore-time': cmd({
    group: B, summary: 'Restore to a point in time (or into a new preview branch with --branch)',
    usage: '[ref] <ISO time> [--branch <name>] [--yes]', need: 1, method: 'POST', path: '/backups/pitr',
    description: 'Without --branch the project\'s database goes back to that moment (the current state is backed up first).',
    options: '--branch <name>   Restore into a new preview branch with this name; production stays as it is',
    examples: `stitchdb backups restore-time 2026-11-01T14:30:00Z --yes
stitchdb backups restore-time 2026-11-01T14:30:00Z --branch before-incident`,
    flags: { branch: { type: 'string' } },
    body: ({ args, flags }) => ({ target_time: isoTime(args[0], 'time to restore to'), ...(flags.branch ? { branch: String(flags.branch) } : {}) }),
    confirm: ({ args, flags, ref }) => (flags.branch ? `Restore ${ref} as of ${args[0]} into a new branch "${flags.branch}"?`
      : `Restore ${ref} to ${args[0]}? Everything written after that moment is rolled back (a copy of the current state is kept).`),
    done: (r) => `Restore started${r?.id ? ` (job ${r.id})` : ''}. Follow it with "stitchdb backups jobs".`,
  }),
  'backups jobs': cmd({
    group: B, summary: 'Restore and backup jobs with their progress (or one job)',
    usage: '[ref] [job id]', method: 'GET',
    path: ({ args }) => (args[0] ? `/backups/jobs/${intArg(args[0], 'job id')}` : '/backups/jobs'),
    show: (r) => (Array.isArray(r) ? rows(r, ['id', 'kind', 'status', 'step', 'progress', 'started_at', 'finished_at', 'error'].filter((k) => r.some((x) => x[k] !== undefined))) : show(r)),
  }),
  'backups restore-table': cmd({
    group: B, summary: 'Restore one table or some rows to a point in time',
    usage: '[ref] <schema.table> --time <ISO time> [--mode copy|replace|merge] [--where <sql>] [--yes]', need: 1, method: 'POST', path: '/backups/table-restore',
    description: `copy (default) brings the table back next to the current one under a new name; replace swaps it in; merge puts back
the rows that match --where (or all missing rows).`,
    options: `--time <ISO>     The moment to restore from
--mode <mode>    copy (default), replace or merge
--where <sql>    One SQL condition for merge, like "id in (1, 2)"`,
    examples: `stitchdb backups restore-table public.orders --time 2026-11-01T09:00:00Z
stitchdb backups restore-table public.orders --time 2026-11-01T09:00:00Z --mode merge --where "customer_id = 42" --yes`,
    flags: { time: { type: 'string' }, mode: { type: 'string' }, where: { type: 'string' } },
    body({ args, flags }) {
      const t = tableArg(args[0]);
      const mode = flags.mode || 'copy';
      if (!['copy', 'replace', 'merge'].includes(mode)) U.fail('--mode is copy, replace or merge.');
      if (flags.where && mode !== 'merge') U.fail('--where works with --mode merge.');
      return { ...t, mode, ...(flags.where ? { where: flags.where } : {}), target_time: isoTime(flags.time, '--time') };
    },
    confirm: ({ args, flags }) => ((flags.mode || 'copy') === 'copy' ? `Restore a copy of ${args[0]} as of ${flags.time}?`
      : `Restore ${args[0]} as of ${flags.time} (${flags.mode})? Current rows ${flags.mode === 'replace' ? 'are replaced' : 'that match are overwritten'}.`),
    done: (r) => `Table restore started${r?.id ? ` (job ${r.id})` : ''}. Follow it with "stitchdb backups jobs".`,
  }),
};

// ---------- compute, restart ----------
const compute = {
  'compute get': cmd({
    group: 'Compute', summary: 'Compute size: the current size, where it can move and any dedicated server',
    usage: '[ref]', method: 'GET', path: '/compute', branch: false,
    show(r) {
      M.fields([['Project', r.project?.ref], ['Region', r.project?.region], ['Dedicated', M.yes(r.project?.on_dedicated)], ['Plan', r.plan],
        ['Can change', r.eligible ? 'yes' : U.c.yellow(r.reason || 'no')], ['Current server', r.current ? `${r.current.label || r.current.size || ''} ${r.current.status || ''}`.trim() : 'shared']]);
      if ((r.servers || []).length) { U.log(`\n${U.c.bold('Servers')}`); rows(r.servers); }
      U.log(U.c.dim('\n  Sizes: stitchdb compute sizes'));
    },
  }),
  'compute sizes': cmd({
    group: 'Compute', summary: 'Compute sizes with their size_key and price',
    usage: '[ref] [--location <name>] [--kind cloud|auction|large] [--need-gb <n>]', method: 'GET', path: '/compute/catalog', branch: false,
    options: `--location <name>   Sizes in this location (default: the project's)
--kind <kind>       cloud (default), auction (dedicated hardware, monthly) or large (large storage)
--need-gb <n>       Large storage: the disk you need`,
    flags: { location: { type: 'string' }, kind: { type: 'string' }, needGb: { type: 'string' } },
    query({ flags }) {
      if (flags.kind !== undefined && !['cloud', 'auction', 'large'].includes(flags.kind)) U.fail('--kind is cloud, auction or large.');
      return { location: flags.location, kind: flags.kind, need_gb: flags.needGb };
    },
    show(r) {
      const list = r.sizes || r.offers || r.servers || [];
      U.table(['SIZE KEY', 'SIZE', 'RAM', 'CPU', 'DISK', 'BILLING', 'LOCATION', 'PER MONTH'], list.map((x) => [x.key, x.label || '', x.ram_gb != null ? `${x.ram_gb} GB` : '',
        x.cpu ? `${x.cpu.cores ?? ''}${x.cpu.dedicated ? ' dedicated' : ''}` : '', x.disk_gb || x.usable_gb ? `${x.disk_gb || x.usable_gb} GB` : '', x.billing || '', x.location || '',
        x.price?.month_cents != null ? `$${(x.price.month_cents / 100).toFixed(2)}` : '']));
      U.log(U.c.dim('  Price one: stitchdb compute estimate <size key>; move: stitchdb compute set <size key>'));
    },
  }),
  'compute estimate': cmd({
    group: 'Compute', summary: 'What a compute size costs (changes nothing)',
    usage: '[ref] <size_key>', need: 1, method: 'POST', path: '/compute/estimate', branch: false,
    body: ({ args }) => ({ size_key: need(args[0], 'Give the size key (stitchdb compute sizes).') }),
  }),
  'compute set': cmd({
    group: 'Compute', summary: 'Change the compute size (billed from the prepaid balance)',
    usage: '[ref] <size_key> [--yes]', need: 1, method: 'POST', path: '/compute', branch: false,
    description: 'The new size is billed from the organization\'s prepaid balance. The move restarts the database briefly.',
    body: ({ args }) => ({ size_key: need(args[0], 'Give the size key (stitchdb compute sizes).'), idempotency_key: require('crypto').randomUUID() }),
    async before(c) {
      try { c.estimate = await F.call('POST', `/projects/${c.ref}/compute/estimate`, { body: { size_key: c.args[0] } }); } catch { c.estimate = null; }
    },
    confirm: ({ args, ref, estimate: e }) => `Move ${ref} to ${e?.size ? `${e.size} (${args[0]})` : args[0]}${e?.month_cents != null ? `, $${(e.month_cents / 100).toFixed(2)}/month` : ''}? It is billed from your prepaid balance.`,
    done: (r, { args }) => `Compute change to ${args[0]} requested${r?.status ? ` (${r.status})` : ''}.`,
  }),
  'projects restart': cmd({
    group: 'Projects', summary: 'Restart the project\'s Auth and REST services',
    usage: '[ref] [--yes]', method: 'POST', path: '/restart',
    confirm: ({ ref }) => `Restart Auth and REST of ${ref}? Requests fail for a few seconds.`,
    done: (r, { ref }) => `Restarted ${ref}.`,
  }),
};

// ---------- replicas ----------
const replicas = {
  'replicas list': cmd({
    group: 'Replicas', summary: 'Read replicas with their connection details, price and failover state',
    usage: '[ref]', method: 'GET', path: '/replicas', branch: false,
  }),
  'replicas add': cmd({
    group: 'Replicas', summary: 'Add a read replica (billed hourly from the prepaid balance)',
    usage: '[ref] [--yes]', method: 'POST', path: '/replicas', branch: false,
    confirm: ({ ref }) => `Add a read replica to ${ref}? It is billed hourly from your prepaid balance.`,
    done: (r) => `Read replica requested${r?.id || r?.node_id ? ` (${r.id || r.node_id})` : ''}.`,
  }),
  'replicas remove': cmd({
    group: 'Replicas', summary: 'Remove a read replica',
    usage: '[ref] <node id> [--yes]', need: 1, method: 'DELETE', branch: false,
    path: ({ args }) => `/replicas/${matchArg(args[0], UUID, 'replica node id (stitchdb replicas list)')}`,
    confirm: ({ args }) => `Remove read replica ${args[0]}? Connections to it stop working.`,
    done: (r, { args }) => `Removed read replica ${args[0]}.`,
  }),
  'replicas auto get': cmd({
    group: 'Replicas', summary: 'Automatic read replicas: settings, running replicas and cost',
    usage: '[ref]', method: 'GET', path: '/auto-replicas', branch: false,
  }),
  'replicas auto set': cmd({
    group: 'Replicas', summary: 'Change the automatic read replica settings',
    usage: '[ref] [key=value]... [--file settings.json]', method: 'PUT', path: '/auto-replicas', branch: false,
    description: 'Fields: enabled, up_pct, up_minutes, down_pct, down_minutes, max_replicas. Replicas are billed hourly from the prepaid balance.',
    options: FILE_OPT, flags: FILE_FLAGS,
    examples: 'stitchdb replicas auto set enabled=true up_pct=70 up_minutes=10 down_pct=30 down_minutes=30 max_replicas=2',
    body: ({ flags, args }) => needBody(input(flags, args)),
    done: () => 'Saved the automatic read replica settings.',
  }),
};

// ---------- budget ----------
const budget = {
  'budget get': cmd({
    group: 'Budget', summary: 'Budget of the project: limits per resource, alerts and what stops at the limit',
    usage: '[ref]', method: 'GET', path: '/budget', branch: false,
  }),
  'budget set': cmd({
    group: 'Budget', summary: 'Set the budget (from a JSON file or key=value fields)',
    usage: '[ref] [key=value]... [--file budget.json]', method: 'PUT', path: '/budget', branch: false,
    description: 'The fields are the ones "stitchdb budget get --json" shows.',
    options: FILE_OPT, flags: FILE_FLAGS,
    examples: `stitchdb budget get --json > budget.json   # edit, then:
stitchdb budget set --file budget.json`,
    body: ({ flags, args }) => needBody(input(flags, args)),
    done: () => 'Saved the budget.',
  }),
  'budget delete': cmd({
    group: 'Budget', summary: 'Remove the budget',
    usage: '[ref] [--yes]', method: 'DELETE', path: '/budget', branch: false,
    confirm: ({ ref }) => `Remove the budget of ${ref}? Nothing stops at a limit any more.`,
    done: () => 'Removed the budget.',
  }),
  'budget test': cmd({
    group: 'Budget', summary: 'Send a test budget alert',
    usage: '[ref]', method: 'POST', path: '/budget/test', branch: false,
    done: () => 'Sent a test budget alert.',
  }),
};

// ---------- full export / import ----------
const jobArg = (v) => matchArg(v, JOB, 'export or import id (16 characters, stitchdb export list)');
const showJob = (j) => M.fields([['ID', j.id], ['Kind', j.kind], ['State', j.state], ['Step', j.step], ['Size', j.size_bytes != null ? M.bytes(j.size_bytes) : null],
  ['Download', j.download_url], ['Upload', j.upload_url], ['Max size', j.max_bytes ? M.bytes(j.max_bytes) : null], ['Expires', day(j.expires_at)], j.error ? ['Error', U.c.red(j.error)] : null]);
const exportCmds = {
  'export list': cmd({
    group: 'Export', summary: 'Full exports and imports with their download / upload links',
    usage: '[ref]', method: 'GET', path: '/export',
    show(r) {
      const jobs = r.jobs || (Array.isArray(r) ? r : []);
      U.table(['ID', 'KIND', 'STATE', 'SIZE', 'CREATED', 'EXPIRES'], jobs.map((j) => [j.id, j.kind, j.state, j.size_bytes != null ? M.bytes(j.size_bytes) : '', day(j.created_at), day(j.expires_at)]));
      if (jobs.some((j) => j.download_url || j.upload_url)) U.log(U.c.dim('  Links: --json'));
    },
  }),
  'export start': cmd({
    group: 'Export', summary: 'Start a full export (database, Storage files, functions and settings)',
    usage: '[ref]', method: 'POST', path: '/export',
    show: (r) => { U.ok('Export started. "stitchdb export list" shows the download link when it is ready.'); showJob(r); },
  }),
  'export import': cmd({
    group: 'Export', summary: 'Start a full import: prints the upload link for an export archive',
    usage: '[ref]', method: 'POST', path: '/export/import',
    description: 'Upload the archive to the link (curl -T archive.tar.gz <url>), then run "stitchdb export restore <id>".',
    show(r) { U.log(`Upload the archive to:\n${r.upload_url}`); U.log(U.c.dim(`  Then: stitchdb export restore ${r.id}`)); },
  }),
  'export restore': cmd({
    group: 'Export', summary: 'Restore an uploaded export archive into this project (organization owner)',
    usage: '[ref] <import id> [--no-functions] [--no-settings] [--yes]', need: 1, method: 'POST',
    options: `--no-functions   Keep the project's Edge Functions
--no-settings    Keep the project's settings`,
    flags: { functions: { type: 'boolean' }, settings: { type: 'boolean' } },
    path: ({ args }) => `/export/import/${jobArg(args[0])}/restore`,
    body: ({ flags, ref }) => ({ confirm: ref, functions: flags.functions !== false, settings: flags.settings !== false }),
    confirm: ({ ref }) => `Import the archive into ${ref}? Everything in its database is replaced.`,
    done: (r) => `Import started${r?.id ? ` (job ${r.id})` : ''}. Follow it with "stitchdb backups jobs".`,
  }),
  'export delete': cmd({
    group: 'Export', summary: 'Delete an export or import',
    usage: '[ref] <id> [--yes]', need: 1, method: 'DELETE',
    path: ({ args }) => `/export/${jobArg(args[0])}`,
    confirm: ({ args }) => `Delete export/import ${args[0]}? Its archive is removed.`,
    done: (r, { args }) => `Deleted ${args[0]}.`,
  }),
};

// ---------- cron ----------
const cron = {
  'cron list': cmd({
    group: 'Cron', summary: 'Scheduled jobs (pg_cron) and their last run',
    usage: '[ref]', method: 'GET', path: '/cron/jobs',
    show: (r) => U.table(['ID', 'NAME', 'SCHEDULE', 'ACTIVE', 'LAST RUN', 'COMMAND'], (r || []).map((j) => [String(j.jobid), j.jobname || '', j.schedule, j.active ? 'yes' : U.c.yellow('no'),
      j.last_run ? `${j.last_run.status} ${U.ago(j.last_run.start_time)}` : '', F.cell(j.command, 50)])),
  }),
  'cron runs': cmd({
    group: 'Cron', summary: 'Recent runs of the scheduled jobs (newest first)',
    usage: '[ref] [--job <id>]', method: 'GET', path: '/cron/runs',
    options: '--job <id>   Runs of one job',
    flags: { job: { type: 'string' } },
    query: ({ flags }) => ({ jobid: flags.job !== undefined ? intArg(flags.job, '--job id') : undefined }),
    show: (r) => U.table(['RUN', 'JOB', 'STATUS', 'STARTED', 'TOOK', 'MESSAGE'], (r || []).map((x) => [String(x.runid), String(x.jobid), x.status === 'failed' ? U.c.red(x.status) : x.status,
      day(x.start_time), x.end_time && x.start_time ? `${((new Date(x.end_time) - new Date(x.start_time)) / 1000).toFixed(1)}s` : '', F.cell(x.return_message, 50)])),
  }),
  'cron create': cmd({
    group: 'Cron', summary: 'Schedule a job (pg_cron)',
    usage: '[ref] <name> --schedule <cron> --command <sql> [--inactive]', need: 1, method: 'POST', path: '/cron/jobs',
    options: `--schedule <cron>   Cron expression (UTC), like "*/5 * * * *", or "30 seconds"
--command <sql>     The SQL to run
--inactive          Create it paused`,
    examples: `stitchdb cron create nightly-cleanup --schedule '0 3 * * *' --command 'delete from events where at < now() - interval ''30 days'''`,
    flags: { schedule: { type: 'string' }, command: { type: 'string' }, inactive: { type: 'boolean' } },
    body: ({ args, flags }) => ({ jobname: need(args[0], 'Give the job name.'), schedule: need(flags.schedule, 'Pass --schedule, like "*/5 * * * *".'),
      command: need(flags.command, 'Pass --command with the SQL to run.'), ...(flags.inactive ? { active: false } : {}) }),
    done: (r, { args }) => `Scheduled ${args[0]} (job ${r.jobid}).`,
  }),
  'cron update': cmd({
    group: 'Cron', summary: 'Change a job (schedule, command, active)',
    usage: '[ref] <job id> [--schedule <cron>] [--command <sql>] [--active | --no-active]', need: 1, method: 'PATCH',
    flags: { schedule: { type: 'string' }, command: { type: 'string' }, active: { type: 'boolean' } },
    path: ({ args }) => `/cron/jobs/${intArg(args[0], 'job id (stitchdb cron list)')}`,
    body({ flags }) {
      const b = {};
      if (flags.schedule !== undefined) b.schedule = String(flags.schedule);
      if (flags.command !== undefined) b.command = String(flags.command);
      if (flags.active !== undefined) b.active = flags.active;
      return needBody(b, 'Pass --schedule, --command or --active / --no-active.');
    },
    done: (r, { args }) => `Updated job ${args[0]}.`,
  }),
  'cron delete': cmd({
    group: 'Cron', summary: 'Unschedule a job',
    usage: '[ref] <job id> [--yes]', need: 1, method: 'DELETE',
    path: ({ args }) => `/cron/jobs/${intArg(args[0], 'job id (stitchdb cron list)')}`,
    confirm: ({ args }) => `Unschedule cron job ${args[0]}?`,
    done: (r, { args }) => `Unscheduled job ${args[0]}.`,
  }),
};

// ---------- queues ----------
const qname = (v) => matchArg(v, /^[A-Za-z0-9_]{1,47}$/, 'queue name (letters, digits and _)');
const qpath = (args, tail = '') => `/queues/${enc(qname(args[0]))}${tail}`;
const msgRows = (r) => U.table(['ID', 'READS', 'ENQUEUED', 'VISIBLE AT', 'MESSAGE'], (r || []).map((m) => [String(m.msg_id), String(m.read_ct), day(m.enqueued_at), day(m.vt), F.cell(m.message, 60)]));
const queues = {
  'queues list': cmd({
    group: 'Queues', summary: 'Queues (pgmq) with their length and age',
    usage: '[ref]', method: 'GET', path: '/queues',
    show: (r) => U.table(['QUEUE', 'LENGTH', 'OLDEST', 'TOTAL', 'TYPE'], (r || []).map((q) => [q.queue_name, M.num(q.queue_length), q.oldest_msg_age_sec != null ? `${q.oldest_msg_age_sec}s` : '',
      M.num(q.total_messages), q.is_partitioned ? 'partitioned' : q.is_unlogged ? 'unlogged' : 'standard'])),
  }),
  'queues create': cmd({
    group: 'Queues', summary: 'Create a queue',
    usage: '[ref] <name> [--type standard|unlogged]', need: 1, method: 'POST', path: '/queues',
    options: '--type <type>   standard (default) or unlogged (faster, lost on a crash)',
    flags: { type: { type: 'string' } },
    body({ args, flags }) {
      const type = flags.type || 'standard';
      if (!['standard', 'unlogged'].includes(type)) U.fail('--type is standard or unlogged.');
      return { name: qname(args[0]), ...(type === 'unlogged' ? { unlogged: true } : {}) };
    },
    done: (r, { args }) => `Created queue ${args[0]}.`,
  }),
  'queues delete': cmd({
    group: 'Queues', summary: 'Delete a queue and its messages',
    usage: '[ref] <name> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => qpath(args),
    confirm: ({ args }) => `Delete queue ${args[0]} and all its messages?`,
    done: (r, { args }) => `Deleted queue ${args[0]}.`,
  }),
  'queues messages': cmd({
    group: 'Queues', summary: 'Messages of a queue (newest 100; --archived for the archive)',
    usage: '[ref] <name> [--archived]', need: 1, method: 'GET', path: ({ args }) => qpath(args, '/messages'),
    flags: { archived: { type: 'boolean' } },
    query: ({ flags }) => ({ archived: flags.archived ? 'true' : undefined }),
    show: msgRows,
  }),
  'queues send': cmd({
    group: 'Queues', summary: 'Send a message (JSON) to a queue',
    usage: '[ref] <name> <json> [--delay <seconds>]', need: 2, method: 'POST', path: ({ args }) => qpath(args, '/messages'),
    options: '--delay <seconds>   Keep it invisible for this long',
    examples: `stitchdb queues send emails '{"to":"ada@example.com","template":"welcome"}'`,
    flags: { delay: { type: 'string' } },
    body({ args, flags }) {
      const raw = need(args[1], 'Give the message as JSON.');
      let message; try { message = JSON.parse(raw); } catch { U.fail('The message is not valid JSON.'); }
      return { message, ...(flags.delay !== undefined ? { delay: M.seconds(flags.delay, '--delay') } : {}) };
    },
    done: (r, { args }) => `Sent message ${r.msg_id} to ${args[0]}.`,
  }),
  'queues read': cmd({
    group: 'Queues', summary: 'Read messages (they stay invisible for --vt seconds)',
    usage: '[ref] <name> [--qty 1] [--vt 30]', need: 1, method: 'POST', path: ({ args }) => qpath(args, '/read'),
    options: `--qty <n>    How many (1-100, default 1)
--vt <secs>  How long they stay invisible to other readers (default 30)`,
    flags: { qty: { type: 'string' }, vt: { type: 'string' } },
    body: ({ flags }) => ({ qty: flags.qty !== undefined ? intArg(flags.qty, '--qty') : 1, vt: flags.vt !== undefined ? M.seconds(flags.vt, '--vt') : 30 }),
    show: msgRows,
  }),
  'queues archive': cmd({
    group: 'Queues', summary: 'Move a message to the queue\'s archive',
    usage: '[ref] <name> <message id>', need: 2, method: 'POST',
    path: ({ args }) => qpath(args, `/messages/${intArg(args[1], 'message id')}/archive`),
    done: (r, { args }) => `Archived message ${args[1]}.`,
  }),
  'queues delete-message': cmd({
    group: 'Queues', summary: 'Delete a message',
    usage: '[ref] <name> <message id> [--yes]', need: 2, method: 'POST',
    path: ({ args }) => qpath(args, `/messages/${intArg(args[1], 'message id')}/delete`),
    confirm: ({ args }) => `Delete message ${args[1]} from ${args[0]}?`,
    done: (r, { args }) => `Deleted message ${args[1]}.`,
  }),
};

// ---------- rate limits ----------
const rateLimits = {
  'rate-limits get': cmd({
    group: 'Rate limits', summary: 'Rate limit rules and recent blocks',
    usage: '[ref]', method: 'GET', path: '/rate-limits',
  }),
  'rate-limits set': cmd({
    group: 'Rate limits', summary: 'Replace the rate limit rules (from a JSON file)',
    usage: '[ref] --file rules.json', method: 'PATCH', path: '/rate-limits',
    description: 'The file holds the list of rules, or { "rules": [...] } (like "stitchdb rate-limits get --json").',
    options: '--file <json>   The rules',
    flags: { file: { type: 'string', alias: 'f' } },
    body({ flags }) {
      need(flags.file, 'Pass --file with the rules (a JSON list).');
      const b = input(flags, [], { array: 'rules' });
      if (!Array.isArray(b.rules)) U.fail(`${flags.file}: a list of rules, or { "rules": [...] }.`);
      return { rules: b.rules };
    },
    done: (r, { flags }) => `Saved the rate limit rules from ${flags.file}.`,
  }),
  'rate-limits sql install': cmd({
    group: 'Rate limits', summary: 'Install the SQL rate-limit function in the database',
    usage: '[ref]', method: 'POST', path: '/rate-limits/sql',
    done: () => 'Installed the SQL rate-limit function.',
  }),
  'rate-limits sql remove': cmd({
    group: 'Rate limits', summary: 'Remove the SQL rate-limit function',
    usage: '[ref] [--yes]', method: 'DELETE', path: '/rate-limits/sql',
    confirm: 'Remove the SQL rate-limit function? Policies and functions that call it stop working.',
    done: () => 'Removed the SQL rate-limit function.',
  }),
};

// ---------- SAML SSO ----------
const SSO = '/config/auth/sso/providers';
const SSO_FLAGS = { metadataUrl: { type: 'string' }, metadataFile: { type: 'string' }, domain: { type: 'array' }, attributeMapping: { type: 'string' } };
const SSO_OPT = `--metadata-url <url>       The identity provider's SAML metadata URL (https)
--metadata-file <xml>      Its metadata XML, from a file
--domain <a.com>           E-mail domain that signs in with it (repeatable or comma-separated)
--attribute-mapping <json> Attribute mapping, from a JSON file`;
function ssoBody(flags, { partial }) {
  const b = {};
  if (flags.metadataUrl) b.metadata_url = String(flags.metadataUrl);
  else if (flags.metadataFile) b.metadata_xml = M.readText(flags.metadataFile);
  else if (!partial) U.fail('Pass --metadata-url <url> or --metadata-file <xml>.');
  if (flags.domain) b.domains = flags.domain;
  else if (!partial) U.fail('Pass --domain with the e-mail domain(s) that sign in with it.');
  if (flags.attributeMapping) b.attribute_mapping = M.readJson(flags.attributeMapping);
  return partial ? needBody(b, 'Pass --metadata-url, --metadata-file, --domain or --attribute-mapping.') : b;
}
const ssoId = (v) => matchArg(v, UUID, 'provider id (stitchdb auth sso list)');
const sso = {
  'auth sso list': cmd({
    group: 'Auth', summary: 'SAML SSO providers',
    usage: '[ref]', method: 'GET', path: SSO,
    show: (r) => U.table(['ID', 'DOMAINS', 'METADATA', 'CREATED'], (r.items || []).map((x) => [x.id, M.list((x.domains || []).map((d) => d.domain || d)),
      F.cell(x.saml?.metadata_url || (x.saml?.entity_id ? `entity ${x.saml.entity_id}` : ''), 50), day(x.created_at)])),
  }),
  'auth sso add': cmd({
    group: 'Auth', summary: 'Add a SAML SSO provider (turn SAML on in the Auth settings first)',
    usage: '[ref] --metadata-url <url> | --metadata-file <xml> --domain <a.com>... [--attribute-mapping <json>]', method: 'POST', path: SSO,
    options: SSO_OPT, flags: SSO_FLAGS,
    examples: 'stitchdb auth sso add --metadata-url https://idp.example.com/saml/metadata --domain example.com',
    body: ({ flags }) => ssoBody(flags, { partial: false }),
    done: (r) => `Added SAML provider ${r?.id || ''}.`.replace(' .', '.'),
  }),
  'auth sso update': cmd({
    group: 'Auth', summary: 'Change a SAML SSO provider',
    usage: '[ref] <provider id> [--metadata-url <url> | --metadata-file <xml>] [--domain <a.com>]... [--attribute-mapping <json>]', need: 1, method: 'PUT',
    options: SSO_OPT, flags: SSO_FLAGS,
    path: ({ args }) => `${SSO}/${ssoId(args[0])}`,
    body: ({ flags }) => ssoBody(flags, { partial: true }),
    done: (r, { args }) => `Updated SAML provider ${args[0]}.`,
  }),
  'auth sso remove': cmd({
    group: 'Auth', summary: 'Remove a SAML SSO provider',
    usage: '[ref] <provider id> [--yes]', need: 1, method: 'DELETE',
    path: ({ args }) => `${SSO}/${ssoId(args[0])}`,
    confirm: ({ args }) => `Remove SAML provider ${args[0]}? Its users can no longer sign in with SSO.`,
    done: (r, { args }) => `Removed SAML provider ${args[0]}.`,
  }),
};

// ---------- recycle bin, change history ----------
const ids = (args) => {
  if (!args.length) U.fail('Give one or more row ids (stitchdb recycle-bin list).');
  return args.map((x) => (/^\d+$/.test(x) ? Number(x) : x));
};
function tableToggle(base, what, on) {
  return cmd({
    group: what === 'recycle bin' ? 'Recycle bin' : 'Change history',
    summary: on ? `Turn the ${what} on for a table` : `Turn the ${what} off for a table`,
    usage: `[ref] <schema.table>${on ? '' : ' [--yes]'}`, need: 1, method: 'PUT', path: `${base}/tables`,
    body: ({ args }) => ({ ...tableArg(args[0]), enabled: on }),
    confirm: on ? undefined : ({ args }) => `Turn the ${what} off for ${args[0]}? What it kept for that table is dropped.`,
    done: (r, { args }) => `${what === 'recycle bin' ? 'Recycle bin' : 'Change history'} ${on ? 'on' : 'off'} for ${args[0]}.`,
  });
}
const tableQuery = ({ flags }) => ({ table: flags.table, limit: flags.limit, before: flags.before, pk: flags.pk });
const bins = {
  'recycle-bin list': cmd({
    group: 'Recycle bin', summary: 'Deleted rows kept by the recycle bin and the tables it covers',
    usage: '[ref] [--table <schema.table>] [--limit 50]', method: 'GET', path: '/recycle-bin',
    flags: { table: { type: 'string' }, limit: { type: 'string' } }, query: tableQuery,
  }),
  'recycle-bin enable': tableToggle('/recycle-bin', 'recycle bin', true),
  'recycle-bin disable': tableToggle('/recycle-bin', 'recycle bin', false),
  'recycle-bin restore': cmd({
    group: 'Recycle bin', summary: 'Restore deleted rows',
    usage: '[ref] <id>...', need: 1, method: 'POST', path: '/recycle-bin/restore',
    body: ({ args }) => ({ ids: ids(args) }),
    done: (r, { args }) => `Restored ${r?.restored ?? args.length} row(s).`,
  }),
  'recycle-bin purge': cmd({
    group: 'Recycle bin', summary: 'Delete rows from the bin for good',
    usage: '[ref] <id>... [--yes]', need: 1, method: 'POST', path: '/recycle-bin/purge',
    body: ({ args }) => ({ ids: ids(args) }),
    confirm: ({ args }) => `Delete ${args.length} row(s) from the recycle bin for good?`,
    done: (r, { args }) => `Purged ${r?.deleted ?? args.length} row(s).`,
  }),
  'history list': cmd({
    group: 'Change history', summary: 'Row changes and the tables that keep a history',
    usage: '[ref] [--table <schema.table>] [--pk <primary key>] [--limit 50] [--before <id>]', method: 'GET', path: '/history',
    flags: { table: { type: 'string' }, pk: { type: 'string' }, limit: { type: 'string' }, before: { type: 'string' } }, query: tableQuery,
  }),
  'history enable': tableToggle('/history', 'change history', true),
  'history disable': tableToggle('/history', 'change history', false),
  'history revert': cmd({
    group: 'Change history', summary: 'Revert one change',
    usage: '[ref] <change id> [--yes]', need: 1, method: 'POST', path: '/history/revert',
    body: ({ args }) => ({ id: intArg(args[0], 'change id (stitchdb history list)') }),
    confirm: ({ args }) => `Revert change ${args[0]}? The row goes back to how it was before it.`,
    done: (r, { args }) => `Reverted change ${args[0]}.`,
  }),
};

// ---------- shared views ----------
const viewId = (v) => matchArg(v, VIEW, 'view id (sv_…, stitchdb shared-views list)');
const VIEW_FLAGS = { ...FILE_FLAGS, name: { type: 'string' }, table: { type: 'string' }, columns: { type: 'array' }, editable: { type: 'array' }, filters: { type: 'string' }, disabled: { type: 'boolean' } };
const VIEW_OPT = `--name <name>          Name of the view
--table <table>        Table in the public schema
--columns <a,b>        Columns to show
--editable <a,b>       Columns people may change
--filters <json>       Filters, from a JSON file
${FILE_OPT}`;
function viewBody(flags, args, { create }) {
  const b = input(flags, args);
  if (flags.name !== undefined) b.name = flags.name;
  if (flags.table !== undefined) b.table = String(flags.table).replace(/^public\./, '');
  if (flags.columns) b.columns = flags.columns;
  if (flags.editable) b.editable = flags.editable;
  if (flags.filters) b.filters = M.readJson(flags.filters);
  if (flags.disabled !== undefined) b.disabled = flags.disabled;
  if (create) { need(b.name, 'Pass --name.'); need(b.table, 'Pass --table (a table in the public schema).'); if (!b.columns?.length) U.fail('Pass --columns with the columns to show.'); }
  return needBody(b);
}
const showView = (v) => {
  M.fields([['ID', v.id], ['Name', v.name], ['Table', v.table], ['Columns', M.list(v.columns)], ['Editable', M.list(v.editable)], ['Disabled', M.yes(v.disabled)], ['URL', v.url]]);
  if (v.members) { U.log(`\n${U.c.bold('Members')}`); U.table(['E-MAIL', 'ADDED', 'LAST SEEN'], v.members.map((m) => [m.email, day(m.added_at), m.last_seen_at ? U.ago(m.last_seen_at) : ''])); }
};
const shared = {
  'shared-views list': cmd({
    group: 'Shared views', summary: 'Shared table views (read-only links for people without dashboard access)',
    usage: '[ref]', method: 'GET', path: '/shared-views',
    show: (r) => U.table(['ID', 'NAME', 'TABLE', 'MEMBERS', 'DISABLED', 'URL'], (r.views || []).map((v) => [v.id, v.name, v.table, String(v.member_count ?? ''), v.disabled ? 'yes' : '', v.url])),
  }),
  'shared-views create': cmd({
    group: 'Shared views', summary: 'Create a shared view of a table',
    usage: '[ref] --name <name> --table <table> --columns <a,b> [--editable <a,b>] [--filters <json>] [--file view.json]', method: 'POST', path: '/shared-views',
    options: VIEW_OPT, flags: VIEW_FLAGS,
    examples: 'stitchdb shared-views create --name "Open orders" --table orders --columns id,customer,total,status',
    body: ({ flags, args }) => viewBody(flags, args, { create: true }),
    show: (r) => { U.ok(`Created shared view ${r.id}.`); showView(r); },
  }),
  'shared-views get': cmd({
    group: 'Shared views', summary: 'One shared view with its members',
    usage: '[ref] <view id>', need: 1, method: 'GET', path: ({ args }) => `/shared-views/${viewId(args[0])}`, show: showView,
  }),
  'shared-views update': cmd({
    group: 'Shared views', summary: 'Change a shared view',
    usage: '[ref] <view id> [--name] [--columns] [--editable] [--filters <json>] [--disabled | --no-disabled] [key=value]...', need: 1, method: 'PATCH',
    options: VIEW_OPT, flags: VIEW_FLAGS,
    path: ({ args }) => `/shared-views/${viewId(args[0])}`,
    body: ({ flags, args }) => viewBody(flags, args.slice(1), { create: false }),
    show: (r) => { U.ok(`Updated ${r.id}.`); showView(r); },
  }),
  'shared-views delete': cmd({
    group: 'Shared views', summary: 'Delete a shared view',
    usage: '[ref] <view id> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => `/shared-views/${viewId(args[0])}`,
    confirm: ({ args }) => `Delete shared view ${args[0]}? Its link stops working.`,
    done: (r, { args }) => `Deleted ${args[0]}.`,
  }),
  'shared-views members add': cmd({
    group: 'Shared views', summary: 'Give people access to a shared view by e-mail',
    usage: '[ref] <view id> <email>... [--no-send]', need: 2, method: 'POST',
    options: '--no-send   Do not e-mail them the link',
    flags: { send: { type: 'boolean' } },
    path: ({ args }) => `/shared-views/${viewId(args[0])}/members`,
    body({ args, flags }) {
      const emails = args.slice(1).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
      if (!emails.length) U.fail('Give one or more e-mail addresses.');
      return { emails, ...(flags.send === false ? { send: false } : {}) };
    },
    done: (r) => `Added ${M.list(r.added)}${r.sent?.length ? ` (e-mailed ${r.sent.length})` : ''}.`,
  }),
  'shared-views members remove': cmd({
    group: 'Shared views', summary: 'Remove a person from a shared view',
    usage: '[ref] <view id> <email> [--yes]', need: 2, method: 'DELETE',
    path: ({ args }) => `/shared-views/${viewId(args[0])}/members`,
    query: ({ args }) => ({ email: need(args[1], 'Give the e-mail address.') }),
    confirm: ({ args }) => `Remove ${args[1]} from ${args[0]}?`,
    done: (r, { args }) => `Removed ${args[1]}.`,
  }),
  'shared-views audit': cmd({
    group: 'Shared views', summary: 'Who opened or changed the view and when',
    usage: '[ref] <view id> [--limit 100] [--before <id>]', need: 1, method: 'GET',
    flags: { limit: { type: 'string' }, before: { type: 'string' } },
    path: ({ args }) => `/shared-views/${viewId(args[0])}/audit`,
    query: ({ flags }) => ({ limit: flags.limit, before: flags.before }),
    show: (r) => U.table(['ID', 'WHEN', 'WHO', 'ACTION', 'ROW'], (r.entries || r.audit || (Array.isArray(r) ? r : [])).map((a) => [String(a.id), day(a.at), a.email, a.action, F.cell(a.pk, 30)])),
  }),
};

module.exports = { ...backups, ...compute, ...replicas, ...budget, ...exportCmds, ...cron, ...queues, ...rateLimits, ...sso, ...bins, ...shared };
