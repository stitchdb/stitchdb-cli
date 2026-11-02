// App features set up through the Management API (access tokens with scopes, like the dashboard): feature flags,
// inbound webhooks, the status page, push and in-app purchase credentials, deep links, usage metering, job monitoring
// and crash reporting. Data-plane calls that use the project's service key (crashes issues, monitors ping, push send,
// metering usage, flags evaluate) are in apps.js.
'use strict';
const U = require('../util');
const M = require('../manage');
const F = require('../feature-cmd');
const { cmd, input, needBody, need, intArg, matchArg, enc } = F;

const FILE_OPT = `--file <json>         Fields from a JSON file (key=value arguments win)
key=value             A field; dots reach nested ones; values are JSON when they look like it`;
const FILE_FLAGS = { file: { type: 'string', alias: 'f' }, set: { type: 'array' } };
const day = (d) => (d ? M.date(d) : '');
const fileBody = ({ flags, args }) => needBody(input(flags, args));

// "<prefix> status|on|off" for a feature at <base>.
function onOff(group, prefix, base, what, { statusName = 'status', statusSummary, show, offWarning } = {}) {
  return {
    [`${prefix} ${statusName}`]: cmd({ group, summary: statusSummary || `${what[0].toUpperCase()}${what.slice(1)}: state and settings`, usage: '[ref]', method: 'GET', path: base, show }),
    [`${prefix} on`]: cmd({ group, summary: `Turn ${what} on`, usage: '[ref]', method: 'POST', path: base, done: (r, { ref }) => `${what[0].toUpperCase()}${what.slice(1)} is on for ${ref}.` }),
    [`${prefix} off`]: cmd({
      group, summary: `Turn ${what} off`, usage: '[ref] [--yes]', method: 'DELETE', path: base,
      confirm: ({ ref }) => `Turn ${what} off for ${ref}?${offWarning ? ' ' + offWarning : ''}`,
      done: (r, { ref }) => `${what[0].toUpperCase()}${what.slice(1)} is off for ${ref}.`,
    }),
  };
}
// "<name> --file f.json" -> PUT/PATCH base.
const setFile = (group, summary, method, path, done, extra = {}) => cmd({
  group, summary, usage: '[ref] --file <json> | key=value...', method, path, options: FILE_OPT, flags: FILE_FLAGS, body: fileBody, done: () => done, ...extra,
});

// ---------- feature flags ----------
const FF = 'Feature flags';
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const fkey = (v, what = 'flag key') => matchArg(v, KEY_RE, what);
const FLAG_FLAGS = { ...FILE_FLAGS, type: { type: 'string' }, description: { type: 'string' }, enabled: { type: 'boolean' } };
const FLAG_OPT = `--type <type>          boolean (default), string, number or json (on create)
--description <text>   What the flag is for
--enabled              Serve it (--no-enabled: serve the off variation)
${FILE_OPT}`;
function flagBody(flags, args, key) {
  const b = input(flags, args);
  if (key) b.key = key;
  if (flags.type !== undefined) b.type = flags.type;
  if (flags.description !== undefined) b.description = flags.description;
  if (flags.enabled !== undefined) b.enabled = flags.enabled;
  return b;
}
const showFlags = (r) => {
  M.fields([['Enabled', M.yes(r.enabled)], ['API', r.api_url], ['Requests this month', r.usage ? M.num(r.usage.requests) : null]]);
  U.log(`\n${U.c.bold('Flags')}`);
  U.table(['KEY', 'TYPE', 'ON', 'RULES', 'DESCRIPTION'], (r.flags || []).map((f) => [f.key, f.type, f.enabled ? U.c.green('on') : 'off', String((f.rules || []).length), F.cell(f.description, 50)]));
  if ((r.segments || []).length) { U.log(`\n${U.c.bold('Segments')}`); U.table(['KEY', 'NAME', 'INCLUDED', 'CONDITIONS'], r.segments.map((s) => [s.key, s.name, String((s.included || []).length), String((s.conditions || []).length)])); }
};
const flags = {
  ...onOff(FF, 'flags', '/flags', 'feature flags', { statusSummary: 'Feature flags: state, flags and segments', show: showFlags, offWarning: 'Every flag serves its default in your apps.' }),
  'flags create': cmd({
    group: FF, summary: 'Create a feature flag',
    usage: '[ref] <key> [--type boolean|string|number|json] [--description <text>] [--enabled] [--file flag.json] [key=value]...', need: 1, method: 'POST', path: '/flags/flags',
    description: 'Rules, variations, rollout and the default go in the JSON file or key=value fields, as "stitchdb flags status --json" shows them.',
    options: FLAG_OPT, flags: FLAG_FLAGS,
    examples: `stitchdb flags create new-checkout --description "New checkout flow"
stitchdb flags create theme --type string --file theme-flag.json`,
    body: ({ flags: f, args }) => flagBody(f, args.slice(1), fkey(args[0])),
    done: (r) => `Created flag ${r.flag?.key || ''}.`,
  }),
  'flags update': cmd({
    group: FF, summary: 'Change a flag (rules, rollout, variations, enabled)',
    usage: '[ref] <key> [--enabled | --no-enabled] [--description <text>] [--file flag.json] [key=value]...', need: 1, method: 'PATCH',
    options: FLAG_OPT, flags: FLAG_FLAGS,
    examples: `stitchdb flags update new-checkout --enabled
stitchdb flags update new-checkout fallthrough.rollout='[{"variation":0,"weight":20},{"variation":1,"weight":80}]'`,
    path: ({ args }) => `/flags/flags/${enc(fkey(args[0]))}`,
    body: ({ flags: f, args }) => needBody(flagBody(f, args.slice(1)), 'Pass --enabled / --no-enabled, --description, --file or key=value fields.'),
    done: (r, { args }) => (r.unchanged ? `Flag ${args[0]} was already like that.` : `Updated flag ${args[0]}.`),
  }),
  'flags delete': cmd({
    group: FF, summary: 'Delete a flag',
    usage: '[ref] <key> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => `/flags/flags/${enc(fkey(args[0]))}`,
    confirm: ({ args }) => `Delete flag ${args[0]}? Apps that read it get their default value.`,
    done: (r, { args }) => `Deleted flag ${args[0]}.`,
  }),
  'flags stats': cmd({
    group: FF, summary: 'How often a flag was evaluated per variation (30 days)',
    usage: '[ref] <key>', need: 1, method: 'GET', path: ({ args }) => `/flags/flags/${enc(fkey(args[0]))}/stats`,
    show: (r) => U.table(['DAY', 'VARIATION', 'EVALUATIONS'], (r.days || []).map((d) => [d.day, String(d.variation), M.num(d.n)])),
  }),
  'flags segments create': cmd({
    group: FF, summary: 'Create a segment (users by id or by conditions)',
    usage: '[ref] <key> [--name <name>] [--file segment.json] [key=value]...', need: 1, method: 'POST', path: '/flags/segments',
    options: `--name <name>    Display name
${FILE_OPT}`,
    examples: 'stitchdb flags segments create beta-testers --name "Beta testers" included=\'["8f0c…","1a2b…"]\'',
    flags: { ...FILE_FLAGS, name: { type: 'string' } },
    body: ({ flags: f, args }) => ({ ...input(f, args.slice(1)), key: fkey(args[0], 'segment key'), ...(f.name !== undefined ? { name: f.name } : {}) }),
    done: (r) => `Created segment ${r.segment?.key || ''}.`,
  }),
  'flags segments update': cmd({
    group: FF, summary: 'Change a segment',
    usage: '[ref] <key> [--name <name>] [--file segment.json] [key=value]...', need: 1, method: 'PATCH',
    options: `--name <name>    Display name
${FILE_OPT}`,
    flags: { ...FILE_FLAGS, name: { type: 'string' } },
    path: ({ args }) => `/flags/segments/${enc(fkey(args[0], 'segment key'))}`,
    body: ({ flags: f, args }) => needBody({ ...input(f, args.slice(1)), ...(f.name !== undefined ? { name: f.name } : {}) }),
    done: (r, { args }) => `Updated segment ${args[0]}.`,
  }),
  'flags segments delete': cmd({
    group: FF, summary: 'Delete a segment',
    usage: '[ref] <key> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => `/flags/segments/${enc(fkey(args[0], 'segment key'))}`,
    confirm: ({ args }) => `Delete segment ${args[0]}?`,
    done: (r, { args }) => `Deleted segment ${args[0]}.`,
  }),
  'flags history': cmd({
    group: FF, summary: 'Change history of flags and segments',
    usage: '[ref] [--key <key>] [--kind flag|segment] [--limit 50] [--before <id>]', method: 'GET', path: '/flags/history',
    flags: { key: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'string' }, before: { type: 'string' } },
    query: ({ flags: f }) => ({ key: f.key, kind: f.kind, limit: f.limit, before: f.before }),
    show: (r) => {
      U.table(['ID', 'WHEN', 'KIND', 'KEY', 'ACTION', 'BY'], (r.changes || []).map((c) => [String(c.id), day(c.at), c.kind, c.key, c.action, c.by_email || '']));
      if (r.more) U.log(U.c.dim('  More: --before <last id>'));
    },
  }),
  'flags restore': cmd({
    group: FF, summary: 'Restore a flag as it was after (or before) a change',
    usage: '[ref] <history id> [--side before|after]', need: 1, method: 'POST',
    options: '--side <side>   after (default): as the change left it; before: as it was before the change',
    flags: { side: { type: 'string' } },
    path: ({ args }) => `/flags/history/${intArg(args[0], 'history id (stitchdb flags history)')}/restore`,
    body({ flags: f }) {
      if (f.side !== undefined && !['before', 'after'].includes(f.side)) U.fail('--side is before or after.');
      return f.side ? { side: f.side } : {};
    },
    done: (r) => `Restored flag ${r.flag?.key || ''}.`,
  }),
  'flags test': cmd({
    group: FF, summary: 'Evaluate every flag for a test context (changes nothing)',
    usage: '[ref] [--file ctx.json] [--user <id|email>] [--attr key=value]...', method: 'POST', path: '/flags/test',
    description: 'The context file holds { "user": "<id or e-mail>", "attributes": { … }, "anon_id": "…" }.',
    options: `--file <json>        The test context
--user <id|email>    A real user of the project (or a made-up id)
--attr <key=value>   An attribute, repeatable`,
    examples: 'stitchdb flags test --user ada@example.com --attr country=DE --attr plan=pro',
    flags: { file: { type: 'string', alias: 'f' }, user: { type: 'string' }, attr: { type: 'array' } },
    body({ flags: f }) {
      const b = f.file ? input({ file: f.file }) : {};
      if (f.user !== undefined) b.user = f.user;
      if (f.attr) b.attributes = { ...(typeof b.attributes === 'object' && b.attributes ? b.attributes : {}), ...M.pairs(f.attr) };
      return b;
    },
    show(r) {
      U.log(r.user ? `User ${r.user.email || r.user.id}${r.found ? '' : U.c.dim(' (not a user of the project)')}` : 'Anonymous visitor');
      const list = Object.entries(r.flags || {}).map(([k, v]) => [k, F.cell(v && typeof v === 'object' && 'value' in v ? v.value : v, 50), v?.reason ? F.cell(v.reason.kind || v.reason, 30) : '']);
      U.table(['FLAG', 'VALUE', 'WHY'], list);
    },
  }),
};

// ---------- inbound webhooks ----------
const IW = 'Inbound webhooks';
const epArg = (v) => matchArg(v, /^[A-Za-z0-9_-]+$/, 'endpoint (its slug, stitchdb inbound status)');
const EP_FLAGS = { ...FILE_FLAGS, provider: { type: 'string' }, name: { type: 'string' }, function: { type: 'string' }, secret: { type: 'string' }, slug: { type: 'string' }, enabled: { type: 'boolean' }, keepDays: { type: 'string' } };
const EP_OPT = `--provider <name>      stripe, github, shopify, … or hmac / token (see stitchdb inbound status --json)
--name <name>          Display name
--secret <secret>      The provider's signing secret (or INBOUND_SECRET)
--function <name>      Edge Function that handles the events
--slug <slug>          Path part of the endpoint URL (on create)
--keep-days <n>        Delete events after n days
--enabled / --no-enabled
${FILE_OPT}`;
function epBody(f, args) {
  const b = input(f, args);
  for (const [k, v] of [['provider', f.provider], ['name', f.name], ['function', f.function], ['slug', f.slug], ['enabled', f.enabled]]) if (v !== undefined) b[k] = v;
  const secret = f.secret ?? process.env.INBOUND_SECRET;
  if (secret !== undefined && b.secret === undefined) b.secret = secret;
  if (f.keepDays !== undefined) b.keep_days = f.keepDays === 'none' ? null : intArg(f.keepDays, '--keep-days');
  return b;
}
const evArg = (v) => intArg(v, 'event id (stitchdb inbound events list)');
const inbound = {
  ...onOff(IW, 'inbound', '/inbound', 'inbound webhooks', { statusSummary: 'Inbound webhooks: state and endpoints', offWarning: 'Endpoints stop accepting events.' }),
  'inbound endpoints create': cmd({
    group: IW, summary: 'Add an endpoint (provider, signing secret, handler)',
    usage: '[ref] --provider <name> [--name] [--secret <s>] [--function <fn>] [--slug <slug>] [--file endpoint.json]', method: 'POST', path: '/inbound/endpoints',
    options: EP_OPT, flags: EP_FLAGS,
    examples: 'stitchdb inbound endpoints create --provider stripe --name payments --secret "$STRIPE_WEBHOOK_SECRET" --function stripe-events',
    body({ flags: f, args }) { const b = epBody(f, args); need(b.provider, 'Pass --provider.'); return b; },
    done: (r) => `Added endpoint ${r.slug || ''}${r.url ? `: ${r.url}` : ''}`,
  }),
  'inbound endpoints update': cmd({
    group: IW, summary: 'Change an endpoint',
    usage: '[ref] <endpoint> [--name] [--secret] [--function] [--enabled | --no-enabled] [--keep-days n] [--file endpoint.json]', need: 1, method: 'PATCH',
    options: EP_OPT, flags: EP_FLAGS,
    path: ({ args }) => `/inbound/endpoints/${epArg(args[0])}`,
    body: ({ flags: f, args }) => needBody(epBody(f, args.slice(1))),
    done: (r, { args }) => `Updated endpoint ${args[0]}.`,
  }),
  'inbound endpoints delete': cmd({
    group: IW, summary: 'Delete an endpoint (--events also deletes its events)',
    usage: '[ref] <endpoint> [--events] [--yes]', need: 1, method: 'DELETE',
    options: '--events   Also delete the events it received',
    flags: { events: { type: 'boolean' } },
    path: ({ args }) => `/inbound/endpoints/${epArg(args[0])}`,
    query: ({ flags: f }) => ({ events: f.events ? '1' : undefined }),
    confirm: ({ args, flags: f }) => `Delete endpoint ${args[0]}${f.events ? ' and its events' : ''}? Its URL stops accepting events.`,
    done: (r, { args }) => `Deleted endpoint ${args[0]}.`,
  }),
  'inbound endpoints test': cmd({
    group: IW, summary: 'Send a test event to an endpoint',
    usage: '[ref] <endpoint> [--payload <json file>]', need: 1, method: 'POST',
    options: '--payload <file>   The event body (default: a sample event of the provider)',
    flags: { payload: { type: 'string' } },
    path: ({ args }) => `/inbound/endpoints/${epArg(args[0])}/test`,
    body: ({ flags: f }) => (f.payload ? { payload: M.readJson(f.payload) } : {}),
    done: (r, { args }) => `Sent a test event to ${args[0]}${r?.id ? ` (event ${r.id})` : ''}.`,
  }),
  'inbound events list': cmd({
    group: IW, summary: 'Received events, newest first',
    usage: '[ref] [--endpoint <slug>] [--status <status>] [--search <text>] [--limit 50] [--before <id>]', method: 'GET', path: '/inbound/events',
    flags: { endpoint: { type: 'string' }, status: { type: 'string' }, search: { type: 'string', alias: 'q' }, limit: { type: 'string' }, before: { type: 'string' } },
    query: ({ flags: f }) => ({ endpoint: f.endpoint, status: f.status, q: f.search, limit: f.limit, before: f.before }),
    show: (r) => U.table(['ID', 'ENDPOINT', 'TYPE', 'STATUS', 'TRIES', 'RECEIVED', 'ERROR'], ((r && r.events) || (Array.isArray(r) ? r : [])).map((e) => [String(e.id), e.endpoint, e.event_type || '',
      e.status === 'failed' ? U.c.red(e.status) : e.status, String(e.attempts ?? ''), day(e.received_at), F.cell(e.last_error, 40)])),
  }),
  'inbound events get': cmd({
    group: IW, summary: 'One event with its payload',
    usage: '[ref] <event id>', need: 1, method: 'GET', path: ({ args }) => `/inbound/events/${evArg(args[0])}`,
  }),
  'inbound events redeliver': cmd({
    group: IW, summary: 'Process an event again',
    usage: '[ref] <event id>', need: 1, method: 'POST', path: ({ args }) => `/inbound/events/${evArg(args[0])}/redeliver`,
    done: (r, { args }) => `Queued event ${args[0]} again.`,
  }),
  'inbound events delete': cmd({
    group: IW, summary: 'Delete an event',
    usage: '[ref] <event id> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => `/inbound/events/${evArg(args[0])}`,
    confirm: ({ args }) => `Delete event ${args[0]}?`,
    done: (r, { args }) => `Deleted event ${args[0]}.`,
  }),
};

// ---------- status page ----------
const SP = 'Status page';
const incArg = (v) => matchArg(v, /^[a-f0-9]{10}$/, 'incident id (10 characters, stitchdb status-page get)');
const INC_FLAGS = { ...FILE_FLAGS, title: { type: 'string' }, impact: { type: 'string' }, status: { type: 'string' }, message: { type: 'string' }, components: { type: 'array' }, startsAt: { type: 'string' }, endsAt: { type: 'string' } };
const INC_OPT = `--title <text>         Headline
--impact <level>       none, minor, major, critical or maintenance
--status <status>      investigating, identified, monitoring, resolved (maintenance: scheduled, in_progress, completed)
--message <text>       The update text
--components <a,b>     Affected components
--starts-at <ISO>      Start of a maintenance window
--ends-at <ISO>        End of a maintenance window
${FILE_OPT}`;
function incBody(f, args) {
  const b = input(f, args);
  for (const [k, v] of [['title', f.title], ['impact', f.impact], ['status', f.status], ['message', f.message], ['components', f.components]]) if (v !== undefined) b[k] = v;
  if (f.startsAt !== undefined) b.starts_at = F.isoTime(f.startsAt, '--starts-at');
  if (f.endsAt !== undefined) b.ends_at = F.isoTime(f.endsAt, '--ends-at');
  return b;
}
const statusPage = {
  ...onOff(SP, 'status-page', '/status-page', 'the status page', { statusName: 'get', statusSummary: 'Status page: state, settings, components and incidents', offWarning: 'Its URL stops answering.' }),
  'status-page set': setFile(SP, 'Change the page (title, components, checks, notifications) from JSON', 'PUT', '/status-page/settings', 'Saved the status page.', {
    examples: `stitchdb status-page get --json | jq .settings > page.json   # edit, then:
stitchdb status-page set --file page.json`,
  }),
  'status-page incidents create': cmd({
    group: SP, summary: 'Post an incident or scheduled maintenance',
    usage: '[ref] --title <text> --message <text> [--impact minor] [--status investigating] [--components api,db]', method: 'POST', path: '/status-page/incidents',
    options: INC_OPT, flags: INC_FLAGS,
    examples: `stitchdb status-page incidents create --title "Slow API" --impact minor --status investigating --message "We are looking into it." --components api
stitchdb status-page incidents create --title "Database upgrade" --impact maintenance --starts-at 2026-11-09T02:00:00Z --ends-at 2026-11-09T03:00:00Z --message "Short downtime"`,
    body({ flags: f, args }) { const b = incBody(f, args); need(b.title, 'Pass --title.'); return b; },
    done: (r) => `Posted ${r.incident?.impact === 'maintenance' ? 'maintenance' : 'incident'} ${r.incident?.id || ''}.`,
  }),
  'status-page incidents update': cmd({
    group: SP, summary: 'Add an update to an incident or change it',
    usage: '[ref] <incident id> [--status <status>] [--message <text>] [--title] [--impact] [--components]', need: 1, method: 'PATCH',
    options: INC_OPT, flags: INC_FLAGS,
    examples: 'stitchdb status-page incidents update 1a2b3c4d5e --status resolved --message "Fixed."',
    path: ({ args }) => `/status-page/incidents/${incArg(args[0])}`,
    body: ({ flags: f, args }) => needBody(incBody(f, args.slice(1)), 'Pass --status, --message or other fields.'),
    done: (r) => `Updated "${r.incident?.title || ''}" (${r.incident?.status || ''}).`,
  }),
  'status-page incidents delete': cmd({
    group: SP, summary: 'Delete an incident',
    usage: '[ref] <incident id> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => `/status-page/incidents/${incArg(args[0])}`,
    confirm: ({ args }) => `Delete incident ${args[0]} from the status page?`,
    done: (r, { args }) => `Deleted incident ${args[0]}.`,
  }),
  'status-page incidents edit-update': cmd({
    group: SP, summary: 'Edit (or delete) one update of an incident',
    usage: '[ref] <incident id> <update index> --message <text> | --delete [--yes]', need: 2, method: 'PATCH',
    options: `--message <text>   The new text
--delete           Delete this update instead`,
    flags: { message: { type: 'string' }, delete: { type: 'boolean' } },
    path: ({ args }) => `/status-page/incidents/${incArg(args[0])}/updates/${intArg(args[1], 'update index (0 = the first update)')}`,
    body: ({ flags: f }) => (f.delete ? { delete: true } : { message: need(f.message, 'Pass --message with the new text (or --delete).') }),
    confirm: ({ flags: f, args }) => (f.delete ? `Delete update ${args[1]} of incident ${args[0]}?` : null),
    done: (r, { args, flags: f }) => `${f.delete ? 'Deleted' : 'Edited'} update ${args[1]} of ${args[0]}.`,
  }),
  'status-page subscribers list': cmd({
    group: SP, summary: 'E-mail subscribers of the status page',
    usage: '[ref]', method: 'GET', path: '/status-page/subscribers',
  }),
  'status-page subscribers remove': cmd({
    group: SP, summary: 'Remove a subscriber',
    usage: '[ref] <subscriber id> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => `/status-page/subscribers/${intArg(args[0], 'subscriber id')}`,
    confirm: ({ args }) => `Remove subscriber ${args[0]}?`,
    done: (r, { args }) => `Removed subscriber ${args[0]}.`,
  }),
};

// ---------- push ----------
const PN = 'Push notifications';
const push = {
  'push settings': cmd({
    group: PN, summary: 'Push credentials on file (never the keys), devices and recent messages',
    usage: '[ref]', method: 'GET', path: '/push',
  }),
  'push configure': cmd({
    group: PN, summary: 'Set the APNs (.p8) or FCM credentials',
    usage: '[ref] --ios-p8 <file> --key-id <id> --team-id <id> --bundle-id <id> [--sandbox] | --android-service-account <file> | --remove-ios | --remove-android',
    description: 'The keys are stored encrypted on StitchDB and never shown again. Without --ios-p8 the .p8 key on file is kept.',
    options: `--ios-p8 <file>                  The APNs auth key (.p8) from your Apple developer account
--key-id <id>                    Its Key ID (10 characters)
--team-id <id>                   Your Team ID (10 characters)
--bundle-id <id>                 The app's bundle identifier
--sandbox                        Send through the APNs sandbox (development builds)
--android-service-account <file> The FCM service account key (JSON) of your Android app
--remove-ios / --remove-android  Remove those credentials`,
    examples: `stitchdb push configure --ios-p8 AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG --team-id XYZ987TEAM --bundle-id com.example.app
stitchdb push configure --android-service-account fcm-service-account.json`,
    flags: { iosP8: { type: 'string' }, keyId: { type: 'string' }, teamId: { type: 'string' }, bundleId: { type: 'string' }, sandbox: { type: 'boolean' },
      androidServiceAccount: { type: 'string' }, removeIos: { type: 'boolean' }, removeAndroid: { type: 'boolean' } },
    method: 'PATCH', path: '/push',
    body({ flags: f }) {
      const b = {};
      if (f.removeIos) b.ios = null;
      else if (f.iosP8 || f.keyId || f.teamId || f.bundleId) {
        b.ios = { key_id: need(f.keyId, 'Pass --key-id.'), team_id: need(f.teamId, 'Pass --team-id.'), bundle_id: need(f.bundleId, 'Pass --bundle-id.'), production: !f.sandbox };
        if (f.iosP8) b.ios.p8 = M.readText(f.iosP8);
      }
      if (f.removeAndroid) b.android = null;
      else if (f.androidServiceAccount) b.android = { service_account: M.readJson(f.androidServiceAccount) };
      return needBody(b, 'Pass --ios-p8 with --key-id, --team-id and --bundle-id, or --android-service-account.');
    },
    done: (r, { flags: f }) => `Saved the push credentials (${[f.removeIos ? 'iOS removed' : f.keyId ? 'iOS' : '', f.removeAndroid ? 'Android removed' : f.androidServiceAccount ? 'Android' : ''].filter(Boolean).join(', ')}).`,
  }),
  'push test': cmd({
    group: PN, summary: 'Send a test notification to a user',
    usage: '[ref] <user id> [--title <text>] [--body <text>]', need: 1, method: 'POST', path: '/push/test',
    flags: { title: { type: 'string' }, body: { type: 'string' } },
    body: ({ args, flags: f }) => ({ user_id: matchArg(args[0], /^[0-9a-f-]{36}$/i, 'user id (a UUID)'), ...(f.title ? { title: f.title } : {}), ...(f.body ? { body: f.body } : {}) }),
    done: (r, { args }) => `Queued a test notification to ${args[0]}${r?.id ? ` (message ${r.id})` : ''}.`,
  }),
  'push disable': cmd({
    group: PN, summary: 'Turn push notifications off and remove the credentials',
    usage: '[ref] [--yes]', method: 'DELETE', path: '/push',
    confirm: ({ ref }) => `Turn push notifications off for ${ref} and remove the APNs / FCM credentials?`,
    done: () => 'Push notifications are off.',
  }),
};

// ---------- in-app purchases ----------
const IAP = 'Purchases';
const purchases = {
  'purchases settings': cmd({
    group: IAP, summary: 'In-app purchases: store credentials on file (never the keys), products, webhooks, deliveries',
    usage: '[ref]', method: 'GET', path: '/purchases',
  }),
  'purchases configure': setFile(IAP, 'Set the App Store / Google Play credentials, products and webhooks (JSON)', 'PATCH', '/purchases', 'Saved the in-app purchase settings.', {
    description: 'The fields are the ones "stitchdb purchases settings --json" shows; store keys are stored encrypted and never shown again.',
  }),
  'purchases webhook-test': cmd({
    group: IAP, summary: 'Send a test event to a purchase webhook',
    usage: '[ref] <webhook id>', need: 1, method: 'POST', path: ({ args }) => `/purchases/webhooks/${matchArg(args[0], /^[a-f0-9]{10}$/, 'webhook id (10 characters, stitchdb purchases settings)')}/test`,
    done: (r, { args }) => `Sent a test event to webhook ${args[0]}${r?.status ? ` (answered ${r.status})` : ''}.`,
  }),
  'purchases retry': cmd({
    group: IAP, summary: 'Deliver a failed purchase webhook again',
    usage: '[ref] <delivery id>', need: 1, method: 'POST', path: ({ args }) => `/purchases/deliveries/${intArg(args[0], 'delivery id')}/retry`,
    done: (r, { args }) => `Queued delivery ${args[0]} again.`,
  }),
  'purchases disable': cmd({
    group: IAP, summary: 'Turn in-app purchases off and remove the credentials',
    usage: '[ref] [--yes]', method: 'DELETE', path: '/purchases',
    confirm: ({ ref }) => `Turn in-app purchases off for ${ref} and remove the store credentials?`,
    done: () => 'In-app purchases are off.',
  }),
};

// ---------- deep links ----------
const DL = 'Deep links';
const codeArg = (v) => matchArg(v, /^[A-Za-z0-9_-]{1,64}$/, 'link code');
const LINK_FLAGS = { ...FILE_FLAGS, path: { type: 'string' }, code: { type: 'string' }, data: { type: 'string' }, expiresAt: { type: 'string' }, disabled: { type: 'boolean' } };
const LINK_OPT = `--path <path>          Where the link opens in the app (and the web fallback)
--code <code>          The short code (default: a random one, on create)
--data <json>          Data handed to the app, as JSON
--expires-at <ISO>     When the link stops working
--disabled / --no-disabled
${FILE_OPT}`;
function linkBody(f, args) {
  const b = input(f, args);
  if (f.path !== undefined) b.path = f.path;
  if (f.code !== undefined) b.code = f.code;
  if (f.data !== undefined) { try { b.data = JSON.parse(f.data); } catch { U.fail('--data is not valid JSON.'); } }
  if (f.expiresAt !== undefined) b.expires_at = f.expiresAt === 'none' ? null : F.isoTime(f.expiresAt, '--expires-at');
  if (f.disabled !== undefined) b.disabled = f.disabled;
  return b;
}
const links = {
  ...onOff(DL, 'links', '/links', 'links', { statusSummary: 'Deep links and short links: state and settings', offWarning: 'Short links stop redirecting.' }),
  'links settings set': setFile(DL, 'Change the link settings (apps, app stores, fallback, domain) from JSON', 'PUT', '/links/settings', 'Saved the link settings.'),
  'links list': cmd({
    group: DL, summary: 'Short links',
    usage: '[ref] [--search <text>] [--limit 50] [--offset 0]', method: 'GET', path: '/links/items',
    flags: { search: { type: 'string', alias: 'q' }, limit: { type: 'string' }, offset: { type: 'string' } },
    query: ({ flags: f }) => ({ q: f.search, limit: f.limit, offset: f.offset }),
    show: (r) => U.table(['CODE', 'PATH', 'URL', 'CLICKS', 'CREATED', 'EXPIRES'], ((r && (r.links || r.items)) || (Array.isArray(r) ? r : [])).map((l) => [l.code, F.cell(l.path, 40), l.url || '',
      M.num(l.clicks), day(l.created_at), day(l.expires_at)])),
  }),
  'links create': cmd({
    group: DL, summary: 'Create a short link',
    usage: '[ref] --path <path> [--code <code>] [--data <json>] [--expires-at <ISO>]', method: 'POST', path: '/links/items',
    options: LINK_OPT, flags: LINK_FLAGS,
    examples: 'stitchdb links create --path /invite/42 --data \'{"team":42}\' --expires-at 2026-12-31T00:00:00Z',
    body: ({ flags: f, args }) => linkBody(f, args),
    done: (r) => `Created ${r.url || r.code}.`,
  }),
  'links get': cmd({
    group: DL, summary: 'One link with its click statistics',
    usage: '[ref] <code> [--days 30]', need: 1, method: 'GET', path: ({ args }) => `/links/items/${codeArg(args[0])}`,
    flags: { days: { type: 'string' } }, query: ({ flags: f }) => ({ days: f.days }),
  }),
  'links update': cmd({
    group: DL, summary: 'Change a link',
    usage: '[ref] <code> [--path] [--data <json>] [--expires-at <ISO>|none] [--disabled | --no-disabled]', need: 1, method: 'PATCH',
    options: LINK_OPT, flags: LINK_FLAGS,
    path: ({ args }) => `/links/items/${codeArg(args[0])}`,
    body: ({ flags: f, args }) => needBody(linkBody(f, args.slice(1))),
    done: (r, { args }) => `Updated ${args[0]}.`,
  }),
  'links delete': cmd({
    group: DL, summary: 'Delete a link',
    usage: '[ref] <code> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => `/links/items/${codeArg(args[0])}`,
    confirm: ({ args }) => `Delete link ${args[0]}? It stops redirecting.`,
    done: (r, { args }) => `Deleted ${args[0]}.`,
  }),
};

// ---------- usage metering ----------
const UM = 'Usage metering';
const metering = {
  ...onOff(UM, 'metering', '/metering', 'usage metering', { statusSummary: 'Usage metering: state, meters, alerts and the Stripe push', offWarning: 'Usage is no longer recorded.' }),
  'metering settings set': setFile(UM, 'Change meters, plans and alerts (JSON)', 'PUT', '/metering/settings', 'Saved the metering settings.'),
  'metering stripe set': setFile(UM, 'Set the Stripe push (secret key, meters) from JSON', 'PUT', '/metering/stripe', 'Saved the Stripe push.', {
    description: 'The Stripe secret key is stored encrypted and only shown masked.',
  }),
  'metering stripe customers': {
    group: UM, summary: 'End customers and their Stripe customer ids (set <customer>=<cus_…> to link)',
    usage: '[ref] [set <customer>=<cus_id|null>... | set --file customers.json] [--search <text>] [--limit 50]',
    examples: `stitchdb metering stripe customers
stitchdb metering stripe customers set acme=cus_Q1w2e3r4 globex=null`,
    flags: { file: { type: 'string', alias: 'f' }, search: { type: 'string', alias: 'q' }, limit: { type: 'string' } },
    async run({ flags: f, args }) {
      const set = args.includes('set');
      const ref = F.refOf(f, args.filter((a) => a !== 'set'), set ? 1 : 0);
      if (!set) {
        const r = await F.call('GET', `/projects/${ref}/metering/stripe/customers`, { query: { q: f.search, limit: f.limit } });
        U.output(r, () => U.table(['CUSTOMER', 'STRIPE CUSTOMER'], ((r && r.customers) || (Array.isArray(r) ? r : [])).map((c) => [c.customer, c.stripe_customer_id || ''])));
        return r;
      }
      let customers;
      if (f.file) { const j = M.readJson(f.file); customers = Array.isArray(j) ? j : j.customers || [j]; }
      else {
        const list = args.filter((a) => a !== 'set' && a.includes('='));
        if (!list.length) U.fail('Give <customer>=<cus_id> pairs (null removes) or --file.');
        customers = list.map((x) => { const i = x.lastIndexOf('='); const v = x.slice(i + 1); return { customer: x.slice(0, i), stripe_customer_id: v === 'null' || v === '' ? null : v }; });
      }
      const r = await F.call('PUT', `/projects/${ref}/metering/stripe/customers`, { body: { customers } });
      U.output(r, () => U.ok(`Saved ${customers.length} Stripe customer id(s).`));
      return r;
    },
  },
  'metering stripe retry': cmd({
    group: UM, summary: 'Push failed usage to Stripe again',
    usage: '[ref]', method: 'POST', path: '/metering/stripe/retry',
    done: (r) => `Queued ${r?.retried ?? 0} failed meter event(s) again.`,
  }),
};

// ---------- job monitoring ----------
const JM = 'Job monitoring';
const monArg = (v) => intArg(v, 'monitor id (stitchdb monitors setup)');
const MON_FLAGS = { ...FILE_FLAGS, kind: { type: 'string' }, schedule: { type: 'string' }, every: { type: 'string' }, grace: { type: 'string' }, target: { type: 'string' },
  tz: { type: 'string' }, maxRuntime: { type: 'string' }, paused: { type: 'boolean' }, name: { type: 'string' } };
const MON_OPT = `--kind <kind>          ping (an outside job calls a URL; default), cron (a named pg_cron job) or job (a background job)
--target <name>        The pg_cron job or background job name (cron / job)
--schedule <cron>      Expected schedule, like "0 3 * * *" (ping / job)
--every <duration>     Or an interval: 15m, 1h, 1d
--grace <duration>     How late a run may be before it alerts (default 5m)
--tz <zone>            Time zone of the schedule (default UTC)
--max-runtime <dur>    Alert when a run takes longer
--paused / --no-paused
${FILE_OPT}`;
function monBody(f, args) {
  const b = input(f, args);
  if (f.name !== undefined) b.name = f.name;
  if (f.kind !== undefined) b.kind = f.kind;
  if (f.target !== undefined) b.target = f.target;
  if (f.schedule !== undefined) b.schedule = f.schedule;
  if (f.every !== undefined) b.period_s = M.seconds(f.every, '--every');
  if (f.grace !== undefined) b.grace_s = M.seconds(f.grace, '--grace');
  if (f.tz !== undefined) b.tz = f.tz;
  if (f.maxRuntime !== undefined) b.max_runtime_s = f.maxRuntime === 'none' ? null : M.seconds(f.maxRuntime, '--max-runtime');
  if (f.paused !== undefined) b.paused = f.paused;
  return b;
}
const showMonitor = (m) => M.fields([['ID', m.id], ['Name', m.name], ['Kind', m.kind], ['Target', m.target], ['Schedule', m.schedule || (m.period_s ? `every ${m.period_s}s` : null)],
  ['Grace', m.grace_s != null ? `${m.grace_s}s` : null], ['Ping URL', m.ping_url || m.url]]);
const monitors = {
  ...onOff(JM, 'monitors', '/heartbeat', 'job monitoring', { statusName: 'setup', statusSummary: 'Job monitoring: state, alert settings and monitors', offWarning: 'Late or failed jobs no longer alert.' }),
  'monitors alerts set': setFile(JM, 'Change the job monitoring alerts (e-mail, webhook, Slack) from JSON', 'PUT', '/heartbeat/settings', 'Saved the alert settings.', {
    examples: 'stitchdb monitors alerts set email=true slack_webhook=https://hooks.slack.com/services/…',
  }),
  'monitors create': cmd({
    group: JM, summary: 'Add a monitor (ping URL, pg_cron job or background job)',
    usage: '[ref] <name> [--kind ping|cron|job] [--schedule <cron> | --every 1h] [--grace 5m] [--target <job>]', need: 1, method: 'POST', path: '/heartbeat/monitors',
    options: MON_OPT, flags: MON_FLAGS,
    examples: `stitchdb monitors create nightly-backup --schedule '0 3 * * *' --grace 30m
stitchdb monitors create cleanup --kind cron --target nightly-cleanup`,
    body({ flags: f, args }) {
      const b = monBody(f, args.slice(1));
      b.name = need(args[0], 'Give the monitor name.');
      if (!b.kind) b.kind = 'ping';
      if (b.kind !== 'cron' && b.schedule === undefined && b.period_s === undefined) U.fail('Pass --schedule <cron> or --every <duration>.');
      return b;
    },
    show: (r) => { U.ok(`Added monitor ${r.name}.`); showMonitor(r); },
  }),
  'monitors update': cmd({
    group: JM, summary: 'Change a monitor',
    usage: '[ref] <monitor id> [--name] [--schedule | --every] [--grace] [--paused | --no-paused]', need: 1, method: 'PATCH',
    options: MON_OPT, flags: MON_FLAGS,
    path: ({ args }) => `/heartbeat/monitors/${monArg(args[0])}`,
    body: ({ flags: f, args }) => needBody(monBody(f, args.slice(1))),
    done: (r) => `Updated monitor ${r.name || ''}.`,
  }),
  'monitors delete': cmd({
    group: JM, summary: 'Delete a monitor',
    usage: '[ref] <monitor id> [--yes]', need: 1, method: 'DELETE', path: ({ args }) => `/heartbeat/monitors/${monArg(args[0])}`,
    confirm: ({ args }) => `Delete monitor ${args[0]} and its history?`,
    done: (r, { args }) => `Deleted monitor ${args[0]}.`,
  }),
  'monitors rotate': cmd({
    group: JM, summary: 'A new ping URL for a monitor (the old one stops working)',
    usage: '[ref] <monitor id> [--yes]', need: 1, method: 'POST', path: ({ args }) => `/heartbeat/monitors/${monArg(args[0])}/token`,
    confirm: ({ args }) => `Give monitor ${args[0]} a new ping URL? Jobs that call the old one start failing to check in.`,
    show: (r) => { U.ok(`New ping URL for ${r.name || 'the monitor'}.`); showMonitor(r); },
  }),
  'monitors test-alert': cmd({
    group: JM, summary: 'Send a test job monitoring alert',
    usage: '[ref]', method: 'POST', path: '/heartbeat/test',
    done: () => 'Sent a test alert.',
  }),
};

// ---------- crash reporting ----------
const CR = 'Crash reporting';
const crashes = {
  ...onOff(CR, 'crashes', '/crashes', 'crash reporting', { statusName: 'settings', statusSummary: 'Crash reporting: state and alert settings', offWarning: 'New crash reports are dropped.' }),
  'crashes alerts set': setFile(CR, 'Change the crash alerts (new issue, regression, spike; e-mail, webhook, Slack) from JSON', 'PUT', '/crashes/settings', 'Saved the crash alert settings.'),
  'crashes test-alert': cmd({
    group: CR, summary: 'Send a test crash alert',
    usage: '[ref]', method: 'POST', path: '/crashes/test',
    done: () => 'Sent a test alert.',
  }),
};

module.exports = { ...flags, ...inbound, ...statusPage, ...push, ...purchases, ...links, ...metering, ...monitors, ...crashes };
