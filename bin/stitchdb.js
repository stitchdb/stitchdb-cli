#!/usr/bin/env node
// StitchDB CLI: local development, migrations, type generation, Edge Functions, secrets and preview branches.
'use strict';
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) { console.error('stitchdb needs Node.js 18 or newer (you have ' + process.versions.node + ').'); process.exit(1); }

const { parse } = require('../lib/args');
const U = require('../lib/util');
const pkg = require('../package.json');
const COMMANDS = require('../lib/commands');

const GLOBAL = {
  json: { type: 'boolean' }, debug: { type: 'boolean' }, help: { type: 'boolean', alias: 'h' }, version: { type: 'boolean', alias: 'v' },
  projectRef: { type: 'string' }, workdir: { type: 'string' }, yes: { type: 'boolean', alias: 'y' },
};
const GLOBAL_HELP = `  --project-ref <ref>   Project to work on (default: the linked project, or STITCHDB_PROJECT_REF)
  --workdir <dir>       Folder that contains stitchdb/ (default: current folder or a parent)
  --json                Machine-readable output
  -y, --yes             Answer yes to confirmations
  --debug               Show HTTP requests and commands
  -h, --help            Help for a command`;

function mainHelp() {
  const groups = {};
  for (const [name, cmd] of Object.entries(COMMANDS)) if (!cmd.hidden) (groups[cmd.group] ||= []).push([name, cmd.summary]);
  const w = Math.max(...Object.keys(COMMANDS).map((n) => n.length)) + 2;
  let out = `${U.c.bold('StitchDB CLI')} ${pkg.version}\n\nUsage: stitchdb <command> [options]\n`;
  for (const [g, list] of Object.entries(groups)) out += `\n${U.c.bold(g)}\n` + list.map(([n, s]) => `  ${n.padEnd(w)}${s}`).join('\n') + '\n';
  out += `\n${U.c.bold('Global options')}\n${GLOBAL_HELP}\n\nRun "stitchdb <command> --help" for details. Docs: https://stitchdb.com/docs/cli\n`;
  return out;
}
function cmdHelp(name, cmd) {
  let out = `${U.c.bold('stitchdb ' + name)} — ${cmd.summary}\n\nUsage: stitchdb ${name}${cmd.usage ? ' ' + cmd.usage : ''}\n`;
  if (cmd.description) out += `\n${cmd.description.trim()}\n`;
  if (cmd.options) out += `\n${U.c.bold('Options')}\n${cmd.options.trim().split('\n').map((l) => '  ' + l.trim()).join('\n')}\n`;
  if (cmd.examples) out += `\n${U.c.bold('Examples')}\n${cmd.examples.trim().split('\n').map((l) => '  ' + l.trim()).join('\n')}\n`;
  return out + `\n${U.c.bold('Global options')}\n${GLOBAL_HELP}\n`;
}

// "db push" / "migration new" / "functions deploy": the longest command name that matches the arguments.
function resolve(argv) {
  const words = [];
  for (const a of argv) { if (a.startsWith('-')) break; words.push(a); }
  for (let n = Math.min(3, words.length); n > 0; n--) {
    const name = words.slice(0, n).join(' ');
    if (COMMANDS[name]) return { name, rest: argv.slice(n) };
  }
  return { name: words.join(' ') || null, rest: argv.slice(words.length) };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name, rest } = resolve(argv);
  const cmd = name && COMMANDS[name];
  const pre = parse(argv, GLOBAL).flags;
  U.state.json = !!pre.json; U.state.debug = !!pre.debug;
  if (pre.version && !name) { console.log(pkg.version); return; }
  if (!name) { process.stdout.write(mainHelp()); return; }
  if (!cmd) {
    const group = Object.keys(COMMANDS).filter((k) => k.startsWith(name + ' '));
    if (group.length) {
      process.stdout.write(`${U.c.bold('stitchdb ' + name)}\n\n` + group.map((k) => `  ${k.padEnd(28)}${COMMANDS[k].summary}`).join('\n') + '\n\nRun "stitchdb <command> --help" for details.\n');
      return;
    }
    U.fail(`Unknown command "${name}".`, { hint: 'Run "stitchdb --help" for the list of commands.' });
  }
  const { flags, pos } = parse(rest, { ...GLOBAL, ...(cmd.flags || {}) });
  if (flags.help) { process.stdout.write(cmdHelp(name, cmd)); return; }
  U.state.json = !!flags.json; U.state.debug = !!flags.debug;
  const data = await cmd.run({ flags, args: pos });
  if (data !== undefined && U.state.json) U.output(data);
}

main().catch((e) => {
  if (U.state.json) process.stdout.write(JSON.stringify({ error: e.message, hint: e.hint, status: e.status }, null, 2) + '\n');
  else {
    console.error(`${U.c.red('Error:')} ${e.message}`);
    if (e.hint) console.error(U.c.dim(e.hint));
    if (U.state.debug && !(e instanceof U.CliError)) console.error(e.stack);
  }
  process.exit(e.exitCode || 1);
});
