// Output, errors, prompts and small helpers shared by every command. No dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), cyan: paint(36), gray: paint(90) };

class CliError extends Error {
  constructor(message, { hint, code = 1 } = {}) { super(message); this.hint = hint; this.exitCode = code; }
}
const fail = (message, opts) => { throw new CliError(message, opts); };

const state = { json: false, debug: false, quiet: false };
const log = (...a) => { if (!state.json && !state.quiet) console.log(...a); };
const info = (s) => log(`${c.cyan('›')} ${s}`);
const ok = (s) => log(`${c.green('✓')} ${s}`);
const warn = (s) => { if (!state.json) console.error(`${c.yellow('!')} ${s}`); };
const debug = (...a) => { if (state.debug) console.error(c.gray('[debug]'), ...a); };
// Commands return data; in --json mode it is printed as JSON, otherwise `human` renders it.
function output(data, human) {
  if (state.json) { if (!state.printed) process.stdout.write(JSON.stringify(data ?? null, null, 2) + '\n'); state.printed = true; return; }
  if (human) human(data);
}

// Simple aligned table. rows: array of arrays (strings).
function table(head, rows) {
  if (!rows.length) return log(c.dim('  (none)'));
  const all = [head, ...rows].map((r) => r.map((x) => String(x ?? '')));
  // eslint-disable-next-line no-control-regex
  const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const w = head.map((_, i) => Math.max(...all.map((r) => vis(r[i] || ''))));
  const fmt = (r) => '  ' + r.map((x, i) => x + ' '.repeat(Math.max(0, w[i] - vis(x)))).join('   ').trimEnd();
  log(c.bold(fmt(all[0])));
  for (const r of all.slice(1)) log(fmt(r));
}

function ask(question, { hidden = false, def } = {}) {
  if (!process.stdin.isTTY) fail(`${question.replace(/[:?]\s*$/, '')} is required (no terminal to ask on)`, { hint: 'Pass it as a flag or environment variable.' });
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else if (s === '\r\n' || s === '\n') rl.output.write(s); else rl.output.write('*'.repeat(s.length)); };
    }
    rl.question(question + (def ? c.dim(` (${def}) `) : ' '), (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim() || def || ''); });
  });
}
async function confirm(question, { yes = false, def = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY) return def;
  const a = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
  return a ? a === 'y' || a === 'yes' : def;
}

function spinner(text) {
  if (!tty || state.json || state.quiet) { if (!state.json && !state.quiet) console.log(`${c.cyan('›')} ${text}`); return { text() {}, stop() {} }; }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0, t = text;
  const id = setInterval(() => process.stdout.write(`\r${c.cyan(frames[i++ % frames.length])} ${t}\x1b[K`), 80);
  return { text(s) { t = s; }, stop(final) { clearInterval(id); process.stdout.write('\r\x1b[K'); if (final) log(final); } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
function writeFileSafe(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
}
const rel = (p) => path.relative(process.cwd(), p) || '.';
function ago(d) {
  if (!d) return '';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

module.exports = { c, CliError, fail, state, log, info, ok, warn, debug, output, table, ask, confirm, spinner, sleep, exists, writeFileSafe, rel, ago };
