// Features that run on the project's own host, called with the project's service key (lib/project-host.js):
// crashes, analytics, jobs, monitors, metering, push, search, flags evaluate.
'use strict';
const U = require('../util');
const PH = require('../project-host');
const { H } = require('./observe')._observe;
const { enc, need, sure, jsonFlag, num, cut, ts, kv, clean, when } = H;

const FEATURE = { crashes: 'crash reporting', analytics: 'Analytics', jobs: 'background jobs', heartbeat: 'job monitoring', metering: 'usage metering',
  push: 'push notifications', search: 'search', flags: 'feature flags' };
const host = (flags, name, opts) => PH.client(flags, name, FEATURE[name], opts);
const day = (d) => (d ? String(d).slice(0, 10) : '');
const n = (v) => (v == null ? '' : Number(v).toLocaleString('en-US'));
const date = when;

const ISSUE = { open: U.c.yellow('open'), resolved: U.c.green('resolved'), ignored: U.c.gray('ignored') };
function setStatus(status, verb) {
  return {
    group: 'Crash reporting', summary: `Mark a crash issue as ${status}`,
    usage: '<issue id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the issue id (stitchdb crashes issues).');
      if (!/^\d+$/.test(id)) U.fail('The issue id is a number.');
      const c = await host(flags, 'crashes');
      const r = await c.patch(`/issues/${id}`, { status });
      U.ok(`${verb} issue ${id}: ${cut(`${r.type || ''} ${r.message || ''}`.trim(), 70)}`);
      return r;
    },
  };
}

module.exports = {
  // ---------- crashes ----------
  'crashes issues': {
    group: 'Crash reporting', summary: 'Crash and error issues, most recent first',
    usage: '[--status open|resolved|ignored|all] [--release <version>] [--search <text>] [--limit 50]',
    flags: { status: { type: 'string' }, release: { type: 'string', alias: 'r' }, search: { type: 'string', alias: 'q' }, limit: { type: 'string', alias: 'n' }, offset: { type: 'string' } },
    async run({ flags }) {
      const c = await host(flags, 'crashes');
      const r = await c.get('/issues', { status: flags.status, release: flags.release, q: flags.search, limit: flags.limit, offset: flags.offset });
      U.output(r, () => {
        U.table(['ID', 'STATUS', 'ERROR', 'WHERE', 'EVENTS', 'USERS', 'LAST SEEN', 'RELEASE'], (r.issues || []).map((i) => [String(i.id), ISSUE[i.status] || i.status,
          cut(`${i.type || 'Error'}: ${i.message || ''}`, 50), cut(i.culprit || '', 30), n(i.events), n(i.users), U.ago(i.last_seen), i.last_release || '']));
        if (r.total > (r.issues || []).length) U.log(U.c.dim(`${r.total} issues; --limit / --offset for more.`));
      });
      return r;
    },
  },
  'crashes issue': {
    group: 'Crash reporting', summary: 'One crash issue: its stack, releases and latest events',
    usage: '<issue id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the issue id (stitchdb crashes issues).');
      if (!/^\d+$/.test(id)) U.fail('The issue id is a number.');
      const c = await host(flags, 'crashes');
      const r = await c.get(`/issues/${id}`);
      U.output(r, () => {
        const i = r.issue;
        U.log(`${U.c.bold(`${i.type || 'Error'}: ${i.message || ''}`)}  ${ISSUE[i.status] || i.status}`);
        kv([['Where', i.culprit], ['Platform', i.platform], ['Events', n(i.events)], ['Users', n(i.users)], ['First seen', `${ts(i.first_seen)}${i.first_release ? ` in ${i.first_release}` : ''}`],
          ['Last seen', `${ts(i.last_seen)}${i.last_release ? ` in ${i.last_release}` : ''}`], ['Resolved', i.resolved_at && `${ts(i.resolved_at)}${i.resolved_in ? ` in ${i.resolved_in}` : ''}`],
          ['Regressed', i.regressed_at && ts(i.regressed_at)]]);
        const ev = (r.events || [])[0];
        const frames = ev?.exception?.frames || [];
        if (frames.length) {
          U.log(U.c.bold('\n  Stack (latest event)'));
          for (const f of frames.slice(0, 15)) U.log(`  ${f.in_app === false ? U.c.dim('  at') : '  at'} ${f.fn || '?'} ${U.c.dim(`(${f.file || '?'}${f.line != null ? ':' + f.line : ''}${f.col != null ? ':' + f.col : ''})`)}`);
        } else if (ev?.exception?.stack) U.log(U.c.dim(String(ev.exception.stack).split('\n').slice(0, 15).map((l) => '    ' + l).join('\n')));
        if ((r.releases || []).length) { U.log(U.c.bold('\n  Releases')); U.table(['RELEASE', 'EVENTS', 'LAST SEEN'], r.releases.map((x) => [x.release || '(none)', n(x.events), U.ago(x.last_seen)])); }
      });
      return r;
    },
  },
  'crashes resolve': setStatus('resolved', 'Resolved'),
  'crashes ignore': setStatus('ignored', 'Ignored'),
  'crashes reopen': setStatus('open', 'Reopened'),
  'crashes releases': {
    group: 'Crash reporting', summary: 'Crash-free users per release',
    usage: '[--days 30]',
    flags: { days: { type: 'string' } },
    async run({ flags }) {
      const c = await host(flags, 'crashes');
      const r = await c.get('/releases', { days: flags.days });
      const pct = (v) => (v == null ? '–' : `${v}%`);
      U.output(r, () => {
        U.table(['RELEASE', 'CRASH-FREE', 'INSTALLS', 'CRASHED', 'FIRST', 'LAST'], (r.releases || []).map((x) => [x.release || '(none)', pct(x.crash_free_users), n(x.installs), n(x.crashed), day(x.first_day), day(x.last_day)]));
        U.log(U.c.dim(`Last ${r.days} days: ${pct(r.crash_free_users)} crash-free users (${n(r.installs)} installs).`));
      });
      return r;
    },
  },

  // ---------- analytics ----------
  'analytics overview': {
    group: 'Analytics', summary: 'Active users (DAU / WAU / MAU), new users and the top events',
    usage: '[--days 30]',
    flags: { days: { type: 'string' } },
    async run({ flags }) {
      const a = await host(flags, 'analytics');
      const r = await a.get('/overview', { days: flags.days });
      U.output(r, () => {
        kv([['Active users', `${n(r.dau)} today, ${n(r.wau)} this week, ${n(r.mau)} in 30 days`], ['New users', `${n(r.new_users?.day)} today, ${n(r.new_users?.week)} this week, ${n(r.new_users?.period)} in ${r.days} days`]]);
        U.log('');
        U.table(['EVENT', 'EVENTS', 'USERS'], (r.top_events || []).map((e) => [e.name, n(e.events), n(e.users)]));
      });
      return r;
    },
  },
  'analytics trend': {
    group: 'Analytics', summary: 'An event over time (count or unique users), optionally broken down',
    usage: '<event> [--from <date>] [--to <date>] [--interval day|week|month] [--users] [--breakdown platform|release|country|os|<property>]',
    flags: { from: { type: 'string' }, to: { type: 'string' }, interval: { type: 'string' }, users: { type: 'boolean' }, breakdown: { type: 'string' } },
    examples: 'stitchdb analytics trend purchase --from 30d --interval week --breakdown plan',
    async run({ flags, args }) {
      const event = need(args[0], 'Give the event name.');
      const a = await host(flags, 'analytics');
      const r = await a.get('/trend', { event, from: date(flags.from, 'from'), to: date(flags.to, 'to'), interval: flags.interval, measure: flags.users ? 'users' : 'events', breakdown: flags.breakdown });
      U.output(r, () => {
        if (r.breakdown) U.table(['PERIOD', r.breakdown.toUpperCase(), r.measure.toUpperCase()], r.rows.map((x) => [day(x.period), x.value, n(x.n)]));
        else U.table(['PERIOD', r.measure.toUpperCase()], r.rows.map((x) => [day(x.period), n(x.n)]));
        U.log(U.c.dim(`Total: ${n(r.total)} ${r.measure} of ${r.event}, ${day(r.from)} – ${day(r.to)}.`));
      });
      return r;
    },
  },
  'analytics funnel': {
    group: 'Analytics', summary: 'How many users go through the steps, in order',
    usage: '<event> <event> [...] [--from <date>] [--to <date>] [--window-hours 24]',
    examples: 'stitchdb analytics funnel signup onboarding_done purchase --from 30d',
    flags: { from: { type: 'string' }, to: { type: 'string' }, windowHours: { type: 'string' } },
    async run({ flags, args }) {
      if (args.length < 2) U.fail('Give at least two event names, in order.');
      const a = await host(flags, 'analytics');
      const r = await a.post('/funnel', clean({ steps: args, from: date(flags.from, 'from'), to: date(flags.to, 'to'), window_hours: num(flags.windowHours, 'window-hours') }));
      U.output(r, () => {
        const first = r.steps[0]?.users || 0;
        U.table(['STEP', 'EVENT', 'USERS', 'OF FIRST', 'MEDIAN TIME'], r.steps.map((s, i) => [String(i + 1), s.name, n(s.users), first ? `${Math.round((s.users / first) * 1000) / 10}%` : '–',
          s.median_seconds == null ? '' : s.median_seconds < 120 ? `${s.median_seconds} s` : s.median_seconds < 7200 ? `${Math.round(s.median_seconds / 60)} min` : `${(s.median_seconds / 3600).toFixed(1)} h`]));
        U.log(U.c.dim(`Conversion ${r.conversion == null ? '–' : r.conversion + '%'} within ${r.window_hours} h, ${day(r.from)} – ${day(r.to)}.`));
      });
      return r;
    },
  },
  'analytics retention': {
    group: 'Analytics', summary: 'Weekly cohorts: how many users come back',
    usage: '[--weeks 8]',
    flags: { weeks: { type: 'string' } },
    async run({ flags }) {
      const a = await host(flags, 'analytics');
      const r = await a.get('/retention', { weeks: flags.weeks });
      U.output(r, () => {
        const w = Math.max(0, ...(r.cohorts || []).map((c) => c.returned.length));
        U.table(['COHORT', 'USERS', ...Array.from({ length: Math.max(0, w - 1) }, (_, i) => `W${i + 1}`)], (r.cohorts || []).map((c) => [day(c.week), n(c.users),
          ...c.returned.slice(1).map((x) => (c.users ? `${Math.round((x / c.users) * 100)}%` : '–'))]));
      });
      return r;
    },
  },
  'analytics user': {
    group: 'Analytics', summary: 'The latest events of one user',
    usage: '<user id> [--anon] [--limit 100]',
    options: '--anon   The id is an anonymous id (not signed in)\n-n, --limit <n>   How many events',
    flags: { anon: { type: 'boolean' }, limit: { type: 'string', alias: 'n' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the user id (or an anonymous id with --anon).');
      const a = await host(flags, 'analytics');
      const r = await a.get('/user', { [flags.anon ? 'anon_id' : 'user_id']: id, limit: flags.limit });
      U.output(r, () => {
        if (r.user) kv([['User', r.user.user_id || r.user.uid], ['First seen', ts(r.user.first_seen)], ['Last seen', ts(r.user.last_seen)], ['App', [r.user.platform, r.user.os, r.user.release, r.user.country].filter(Boolean).join(', ')]]);
        else U.log(U.c.dim('  No such user.'));
        U.table(['AT', 'EVENT', 'PROPERTIES'], (r.events || []).map((e) => [ts(e.at), e.name, cut(JSON.stringify(e.props || {}), 70)]));
      });
      return r;
    },
  },

  // ---------- jobs ----------
  'jobs list': {
    group: 'Background jobs', summary: 'Recent job runs',
    usage: '[--job <name>] [--status queued|running|sleeping|completed|failed|cancelled] [--long] [--limit 20]',
    flags: { job: { type: 'string' }, status: { type: 'string' }, long: { type: 'boolean' }, limit: { type: 'string', alias: 'n' }, before: { type: 'string' } },
    async run({ flags }) {
      const j = await host(flags, 'jobs');
      const r = await j.get('/runs', { job: flags.job, status: flags.status, mode: flags.long ? 'long' : undefined, limit: flags.limit, before: when(flags.before, 'before') });
      U.output(r, () => U.table(['ID', 'JOB', 'STATUS', 'ATTEMPT', 'CREATED', 'FINISHED', 'ERROR'], (r.runs || []).map((x) => [x.id, x.job, runStatus(x),
        `${x.attempt}/${x.max_attempts}`, U.ago(x.created_at), x.finished_at ? U.ago(x.finished_at) : '', cut(x.error?.message || x.error || '', 40)])));
      return r;
    },
  },
  'jobs get': {
    group: 'Background jobs', summary: 'One job run with its steps',
    usage: '<run id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the run id (stitchdb jobs list).');
      const j = await host(flags, 'jobs');
      const r = await j.get(`/runs/${enc(id)}`);
      U.output(r, () => {
        kv([['Run', r.id], ['Job', r.job], ['Mode', r.mode], ['Status', runStatus(r)], ['Attempt', `${r.attempt} of ${r.max_attempts}`], ['Created', ts(r.created_at)],
          ['Started', r.started_at && ts(r.started_at)], ['Finished', r.finished_at && ts(r.finished_at)], ['Progress', r.progress != null ? `${Math.round(r.progress * 100)}% ${r.message || ''}` : undefined],
          ['Error', r.error && (r.error.message || JSON.stringify(r.error))], ['Result', r.result != null ? cut(JSON.stringify(r.result), 200) : undefined]]);
        if ((r.steps || []).length) { U.log(''); U.table(['STEP', 'KIND', 'STATUS', 'TRIES', 'FINISHED'], r.steps.map((s) => [s.name, s.kind || '', s.status, String(s.attempts ?? ''), s.finished_at ? ts(s.finished_at) : s.wake_at ? `sleeps until ${ts(s.wake_at)}` : ''])); }
      });
      return r;
    },
  },
  'jobs logs': {
    group: 'Background jobs', summary: 'Log lines of a job run (job mode)',
    usage: '<run id> [--follow]',
    options: '-f, --follow   Keep printing new lines until the run ends',
    flags: { follow: { type: 'boolean', alias: 'f' }, interval: { type: 'string' }, polls: { type: 'string' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the run id (stitchdb jobs list).');
      const j = await host(flags, 'jobs');
      const print = (l) => (U.state.json && flags.follow ? process.stdout.write(JSON.stringify(l) + '\n') : U.log(`${U.c.gray(ts(l.at))} ${H.lvl(String(l.level || 'info').padEnd(5))} ${l.line}`));
      let after = -1, all = [];
      const polls = flags.polls ? Number(flags.polls) : Infinity, interval = (num(flags.interval, 'interval') || 2) * 1000;
      for (let i = 0; ; i++) {
        const r = await j.get(`/runs/${enc(id)}/logs`, { after });
        for (const l of r.lines || []) { if (!flags.follow && U.state.json) all.push(l); else print(l); }
        after = r.next;
        if (r.more) continue;
        if (!flags.follow || i + 1 >= polls) break;
        const run = await j.get(`/runs/${enc(id)}`);
        if (['completed', 'failed', 'cancelled'].includes(run.status)) { U.log(U.c.dim(`Run ${run.status}.`)); break; }
        await U.sleep(interval);
      }
      return flags.follow ? undefined : { lines: all, next: after };
    },
  },
  'jobs start': {
    group: 'Background jobs', summary: 'Start a job run (the Edge Function that is the job)',
    usage: '<job> [--payload <json>] [--delay <seconds> | --run-at <time>] [--idempotency-key <key>] [--max-attempts <n>] [--long]',
    options: `--payload <json>          The run's payload (default {})
--delay <seconds>         Start later       --run-at <time>   Start at this time
--idempotency-key <key>   The same key returns the existing run
--max-attempts <n>        Attempts per step (default 5; job mode 1)
--long                    Job mode: one long run (up to the plan's job-mode wall clock)`,
    examples: 'stitchdb jobs start send-digest --payload \'{"day":"2026-11-01"}\'\nstitchdb jobs start reindex --long --idempotency-key reindex-2026-11',
    flags: { payload: { type: 'string' }, delay: { type: 'string' }, runAt: { type: 'string' }, idempotencyKey: { type: 'string' }, maxAttempts: { type: 'string' }, long: { type: 'boolean' } },
    async run({ flags, args }) {
      const job = need(args[0], 'Give the job (the Edge Function\'s slug).');
      const j = await host(flags, 'jobs');
      const r = await j.post('/runs', clean({ job, payload: jsonFlag(flags.payload, 'payload'), delay: num(flags.delay, 'delay'), run_at: flags.runAt ? when(flags.runAt, 'run-at') : undefined,
        idempotency_key: flags.idempotencyKey, max_attempts: num(flags.maxAttempts, 'max-attempts'), mode: flags.long ? 'long' : undefined }));
      U.ok(r.duplicate ? `Run ${r.id} already exists for that idempotency key (${r.status}).` : `Started ${job}: run ${r.id} (${r.status}).`);
      return r;
    },
  },
  'jobs cancel': {
    group: 'Background jobs', summary: 'Cancel a queued, running or sleeping run',
    usage: '<run id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the run id (stitchdb jobs list).');
      await sure(`Cancel run ${id}?`, flags);
      const j = await host(flags, 'jobs');
      const r = await j.post(`/runs/${enc(id)}/cancel`, {});
      U.ok(`Cancelled run ${id}.`);
      return r;
    },
  },
  'jobs retry': {
    group: 'Background jobs', summary: 'Run a failed or cancelled run again (finished steps are kept)',
    usage: '<run id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the run id (stitchdb jobs list).');
      const j = await host(flags, 'jobs');
      const r = await j.post(`/runs/${enc(id)}/retry`, {});
      U.ok(`Run ${id} is queued again.`);
      return r;
    },
  },

  // ---------- monitors ----------
  'monitors list': {
    group: 'Background jobs', summary: 'Job monitors (cron jobs, background jobs and ping monitors) and their state',
    async run({ flags }) {
      const m = await host(flags, 'heartbeat');
      const r = await m.get('/monitors');
      U.output(r, () => U.table(['ID', 'NAME', 'KIND', 'STATE', 'SCHEDULE', 'LAST RUN', 'NEXT DUE'], (r.monitors || []).map((x) => [String(x.id), x.name, x.kind, monState(x.state),
        x.schedule || (x.period_s ? `every ${x.period_s} s` : ''), x.last_run_at ? `${U.ago(x.last_run_at)} (${x.last_status || ''})` : 'never', x.next_due ? ts(x.next_due) : ''])));
      return r;
    },
  },
  'monitors get': {
    group: 'Background jobs', summary: 'One monitor with its run history',
    usage: '<monitor id> [--limit 20]',
    flags: { limit: { type: 'string', alias: 'n' } },
    async run({ flags, args }) {
      const id = need(args[0], 'Give the monitor id (stitchdb monitors list).');
      if (!/^\d+$/.test(id)) U.fail('The monitor id is a number.');
      const m = await host(flags, 'heartbeat');
      const r = await m.get(`/monitors/${id}`, { limit: flags.limit || 20 });
      U.output(r, () => {
        const x = r.monitor;
        kv([['Name', x.name], ['Kind', `${x.kind}${x.target ? ` (${x.target})` : ''}`], ['State', monState(x.state)], ['Schedule', x.schedule ? `${x.schedule} (${x.tz})` : x.period_s ? `every ${x.period_s} s` : undefined],
          ['Grace', `${x.grace_s} s`], ['Max run time', x.max_runtime_s ? `${x.max_runtime_s} s` : undefined], ['Last OK', x.last_ok_at && ts(x.last_ok_at)], ['Down since', x.down_since && ts(x.down_since)],
          ['Next due', x.next_due && ts(x.next_due)], ['Ping URL', x.token ? `${m.t.base}/heartbeat/v1/${x.token}` : undefined]]);
        U.log('');
        U.table(['STARTED', 'STATUS', 'SOURCE', 'DURATION', 'MESSAGE'], (r.runs || []).map((y) => [ts(y.started_at), y.status === 'ok' ? U.c.green('ok') : U.c.red(y.status), y.source || '',
          y.duration_ms != null ? `${y.duration_ms} ms` : '', cut(y.message || '', 50)]));
      });
      return r;
    },
  },
  'monitors ping': {
    group: 'Background jobs', summary: 'Report a run to a ping monitor (from a cron job or script)',
    usage: '<token> [--start | --fail | --exit-code <n>] [--message <text>]',
    description: 'Calls the monitor\'s secret URL. Needs no API key, only the token (hb_…) from Studio.',
    options: `--start            The job started (for its run time)
--fail             The job failed
--exit-code <n>    The job's exit code (0 = it worked)
-m, --message <t>  A message kept with the run (first 2 KB)`,
    examples: 'backup.sh && stitchdb monitors ping hb_… || stitchdb monitors ping hb_… --fail\nstitchdb monitors ping hb_… --exit-code $?',
    flags: { start: { type: 'boolean' }, fail: { type: 'boolean' }, exitCode: { type: 'string' }, message: { type: 'string', alias: 'm' } },
    async run({ flags, args }) {
      const token = need(args[0], 'Give the monitor\'s token (hb_…).');
      if (!/^hb_[A-Za-z0-9]{24}$/.test(token)) U.fail('A monitor token looks like hb_ followed by 24 letters and digits.');
      if (flags.exitCode !== undefined && !/^\d{1,3}$/.test(flags.exitCode)) U.fail('--exit-code is a number from 0 to 255.');
      const what = flags.start ? '/start' : flags.fail ? '/fail' : flags.exitCode !== undefined ? `/${Number(flags.exitCode)}` : '';
      const t = await PH.target(flags, { service: false });
      const r = await PH.call(t, 'POST', `/heartbeat/v1/${token}${what}`, { key: null, feature: FEATURE.heartbeat, body: flags.message ? String(flags.message) : undefined,
        headers: flags.message ? { 'Content-Type': 'text/plain; charset=utf-8' } : undefined });
      U.ok(`Reported ${flags.start ? 'a start' : what && what !== '/0' ? 'a failure' : 'a run that worked'}.`);
      return r ?? { ok: true };
    },
  },

  // ---------- metering ----------
  'metering usage': {
    group: 'Usage metering', summary: 'Usage per customer, meter and period',
    usage: '[--customer <id>] [--meter <name>] [--from 30d] [--to <date>] [--group hour|day|month]',
    flags: { customer: { type: 'string' }, meter: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, group: { type: 'string' } },
    async run({ flags }) {
      const m = await host(flags, 'metering');
      const r = await m.get('/usage', { customer: flags.customer, meter: flags.meter, from: date(flags.from, 'from'), to: date(flags.to, 'to'), group: flags.group });
      U.output(r, () => {
        U.table(['PERIOD', 'CUSTOMER', 'METER', 'VALUE'], (r.rows || []).slice(0, 500).map((x) => [ts(x.period), x.customer, x.meter, `${n(x.value)}${r.meters?.[x.meter]?.unit ? ' ' + r.meters[x.meter].unit : ''}`]));
        if ((r.rows || []).length > 500) U.log(U.c.dim(`${r.rows.length} rows; first 500 shown (--json or "metering export" for all).`));
      });
      return r;
    },
  },
  'metering customers': {
    group: 'Usage metering', summary: 'Totals per customer',
    usage: '[--from 30d] [--to <date>] [--meter <name>] [--search <text>] [--limit 50] [--offset 0]',
    flags: { from: { type: 'string' }, to: { type: 'string' }, meter: { type: 'string' }, search: { type: 'string', alias: 'q' }, limit: { type: 'string', alias: 'n' }, offset: { type: 'string' } },
    async run({ flags }) {
      const m = await host(flags, 'metering');
      const r = await m.get('/customers', { from: date(flags.from, 'from'), to: date(flags.to, 'to'), meter: flags.meter, search: flags.search, limit: flags.limit, offset: flags.offset });
      U.output(r, () => {
        const meters = [...new Set((r.customers || []).flatMap((c) => Object.keys(c.totals || {})))];
        U.table(['CUSTOMER', ...meters.map((x) => x.toUpperCase())], (r.customers || []).map((c) => [c.customer, ...meters.map((x) => n(c.totals?.[x] ?? 0))]));
        if (r.total > (r.customers || []).length) U.log(U.c.dim(`${r.total} customers; --limit / --offset for more.`));
      });
      return r;
    },
  },
  'metering export': {
    group: 'Usage metering', summary: 'Every usage row for billing, as CSV (or JSON)',
    usage: '[-o usage.csv] [--from <date>] [--to <date>] [--group day|hour|month] [--meter <name>] [--customer <id>] [--format csv|json]',
    options: `-o, --output <file>   Write to this file (default: print)
    --format <f>      csv (default) or json`,
    examples: 'stitchdb metering export --from 2026-10-01 --to 2026-11-01 --group month -o october.csv',
    flags: { output: { type: 'string', alias: 'o' }, from: { type: 'string' }, to: { type: 'string' }, group: { type: 'string' }, meter: { type: 'string' }, customer: { type: 'string' }, format: { type: 'string' } },
    async run({ flags }) {
      const format = flags.json ? 'json' : flags.format || 'csv';
      if (!['csv', 'json'].includes(format)) U.fail('--format is csv or json.');
      const m = await host(flags, 'metering');
      const q = { from: date(flags.from, 'from'), to: date(flags.to, 'to'), group: flags.group, meter: flags.meter, customer: flags.customer, format };
      const out = format === 'csv' ? await m.get('/export', q, { raw: true }) : await m.get('/export', q);
      const text = format === 'csv' ? out : JSON.stringify(out, null, 2) + '\n';
      const rows = format === 'csv' ? Math.max(0, text.split(/\r?\n/).filter(Boolean).length - 1) : (out.rows || []).length;
      if (flags.output) {
        U.writeFileSafe(flags.output, text);
        U.ok(`Wrote ${rows} row${rows === 1 ? '' : 's'} to ${U.rel(flags.output)}.`);
        return { file: flags.output, rows, format };
      }
      if (U.state.json) return out;
      process.stdout.write(text);
      return undefined;
    },
  },
  'metering alerts': {
    group: 'Usage metering', summary: 'Threshold alerts that fired, newest first',
    usage: '[--month 2026-10] [--customer <id>] [--limit 100]',
    flags: { month: { type: 'string' }, customer: { type: 'string' }, limit: { type: 'string', alias: 'n' } },
    async run({ flags }) {
      const m = await host(flags, 'metering');
      const r = await m.get('/alerts', { month: flags.month, customer: flags.customer, limit: flags.limit });
      U.output(r, () => U.table(['FIRED', 'CUSTOMER', 'METER', 'THRESHOLD', 'VALUE', 'ALERT'], (r.alerts || []).map((a) => [ts(a.fired_at), a.customer, a.meter_name || a.meter,
        n(a.threshold), n(a.value), a.alert_name || ''])));
      return r;
    },
  },

  // ---------- push ----------
  'push send': {
    group: 'Push notifications', summary: 'Send a push notification to users or a topic',
    usage: '(--user <uuid>[,<uuid>…] | --topic <name>) --title <text> [--body <text>] [--data <json>] [--badge <n>] [--sound <name>] [--send-at <time>] [--no-inbox]',
    options: `--user <ids>       User ids (comma-separated, up to 10,000)
--topic <name>     Everyone subscribed to a topic
--title <text>     The title     --body <text>  The text
--data <json>      Data for the app (up to 3 KB)
--badge <n>        iOS badge     --sound <name>  Sound
--send-at <time>   Send later (ISO time)
--no-inbox         Do not add it to the users' in-app inbox`,
    examples: 'stitchdb push send --user 6f1c…-…-… --title "Your order shipped" --data \'{"order":42}\'\nstitchdb push send --topic news --title "New feature" --body "Dark mode is here"',
    flags: { user: { type: 'array' }, topic: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, data: { type: 'string' }, badge: { type: 'string' },
      sound: { type: 'string' }, sendAt: { type: 'string' }, inbox: { type: 'boolean' } },
    async run({ flags }) {
      if (!flags.user?.length && !flags.topic) U.fail('Choose who gets it: --user <id> or --topic <name>.');
      if (!flags.title && !flags.body) U.fail('Give a --title or a --body.');
      const p = await host(flags, 'push');
      const r = await p.post('/send', clean({ user_ids: flags.user?.length ? flags.user : undefined, topic: flags.user?.length ? undefined : flags.topic, title: flags.title, body: flags.body,
        data: jsonFlag(flags.data, 'data'), badge: flags.badge !== undefined ? Math.round(num(flags.badge, 'badge')) : undefined, sound: flags.sound,
        send_at: flags.sendAt ? when(flags.sendAt, 'send-at') : undefined, inbox: flags.inbox === false ? false : undefined }));
      U.ok(`Queued message ${r.id}. Follow it with "stitchdb push status ${r.id}".`);
      return r;
    },
  },
  'push status': {
    group: 'Push notifications', summary: 'Delivery status of a push message',
    usage: '<message id>',
    async run({ flags, args }) {
      const id = need(args[0], 'Give the message id (from "push send").');
      if (!/^\d+$/.test(id)) U.fail('The message id is a number.');
      const p = await host(flags, 'push');
      const r = await p.get(`/messages/${id}`);
      U.output(r, () => kv([['Message', String(r.id)], ['Status', r.status], ['Devices', n(r.devices)], ['Sent', n(r.sent)], ['Failed', n(r.failed)], ['Error', r.error],
        ['Created', ts(r.created_at)], ['Finished', r.finished_at && ts(r.finished_at)]]));
      return r;
    },
  },

  // ---------- search, flags ----------
  search: {
    group: 'Search', summary: 'Search a table that has a search index (keyword, semantic or hybrid)',
    usage: '<table> <query…> [--limit 20] [--mode hybrid|keyword|semantic] [--select col,col] [--anon]',
    description: 'Runs with the service key (every row), or with --anon as an anonymous visitor (Row Level Security applies).',
    options: `-n, --limit <n>       Results (default 20, at most 100)
    --mode <mode>     hybrid (default when semantic search is on), keyword or semantic
    --select <cols>   Only these columns
    --anon            Search as an anonymous visitor`,
    examples: 'stitchdb search products "red running shoes" --select id,name,price\nstitchdb search docs "reset password" --mode keyword --anon',
    flags: { limit: { type: 'string', alias: 'n' }, mode: { type: 'string' }, select: { type: 'string' }, anon: { type: 'boolean' } },
    async run({ flags, args }) {
      const table = need(args[0], 'Give the table and the query.', 'stitchdb search products "red shoes"');
      const q = need(args.slice(1).join(' ').trim(), 'Give the search query.');
      const s = await host(flags, 'search');
      const r = await s.post(`/${enc(table)}`, clean({ q, limit: num(flags.limit, 'limit'), mode: flags.mode, select: flags.select }), flags.anon ? { key: s.t.anon } : undefined);
      U.output(r, () => {
        const data = r.data || [];
        const cols = flags.select ? flags.select.split(',').map((c) => c.trim()) : [...new Set(data.flatMap((d) => Object.keys(d)))].slice(0, 5);
        U.table(['SCORE', ...cols.map((c) => c.toUpperCase())], data.map((d, i) => [Number(r.scores?.[i]?.score ?? 0).toFixed(3), ...cols.map((c) => cut(typeof d[c] === 'object' ? JSON.stringify(d[c]) : d[c], 40))]));
        U.log(U.c.dim(`${data.length} result${data.length === 1 ? '' : 's'} (${r.mode})${r.note ? `; ${r.note}` : ''}.`));
      });
      return r;
    },
  },
  'flags evaluate': {
    group: 'Feature flags', summary: 'Evaluate the feature flags for a user (server side, server-only flags too)',
    usage: '[--user-id <id>] [--email <e-mail>] [--attributes <json>] [--anon-id <id>] [--keys a,b]',
    examples: 'stitchdb flags evaluate --user-id 6f1c… --attributes \'{"country":"DE","app_version":"2.1.0"}\'\nstitchdb flags evaluate --keys new-checkout --anon-id device-123',
    flags: { userId: { type: 'string' }, email: { type: 'string' }, attributes: { type: 'string' }, anonId: { type: 'string' }, keys: { type: 'array' } },
    async run({ flags }) {
      const f = await host(flags, 'flags');
      const user = flags.userId ? clean({ id: flags.userId, email: flags.email }) : undefined;
      const r = await f.post('/evaluate', clean({ user, attributes: jsonFlag(flags.attributes, 'attributes'), anon_id: flags.anonId, keys: flags.keys }));
      U.output(r, () => U.table(['FLAG', 'VALUE', 'VARIATION', 'REASON'], Object.entries(r.flags || {}).map(([k, v]) => [k, cut(JSON.stringify(v.value), 40), v.variation ?? '', typeof v.reason === 'object' ? JSON.stringify(v.reason) : v.reason ?? ''])));
      return r;
    },
  },
};

function runStatus(r) {
  const s = r.status;
  return s === 'completed' ? U.c.green(s) : s === 'failed' ? U.c.red(s) : s === 'cancelled' ? U.c.gray(s) : U.c.yellow(s);
}
function monState(s) { return s === 'up' ? U.c.green('up') : s === 'down' || s === 'failed' ? U.c.red(s) : U.c.gray(s); }
module.exports._apps = { hidden: true, FEATURE };
