// "A new version is available" notice: asks stitchdb.com/cli/latest.json at most once a day, remembers the answer in
// ~/.stitchdb/update-check.json and prints one line to stderr. Never in --json mode, CI, pipes, or with
// STITCHDB_NO_UPDATE_CHECK=1; never slows a command down by more than a short timeout once a day.
'use strict';
const fs = require('fs');
const path = require('path');
const { HOME } = require('./config');

const FILE = path.join(HOME, 'update-check.json');
const DAY = 24 * 3600 * 1000;

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

function enabled(json) {
  return !json && process.stderr.isTTY && !process.env.CI && !process.env.STITCHDB_NO_UPDATE_CHECK;
}

// Starts the daily check (if due) and returns a function that prints the notice when the command is done.
function start(current, { json } = {}) {
  if (!enabled(json)) return async () => {};
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  let pending = null;
  if (!(Date.now() - (cache.checked_at || 0) < DAY)) {
    pending = fetch('https://stitchdb.com/cli/latest.json', { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        cache = { checked_at: Date.now(), latest: typeof j?.version === 'string' && /^\d+\.\d+\.\d+$/.test(j.version) ? j.version : cache.latest };
        fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
        fs.writeFileSync(FILE, JSON.stringify(cache) + '\n', { mode: 0o600 });
      })
      .catch(() => {});
  }
  return async () => {
    if (pending) await pending;
    if (cache.latest && newer(cache.latest, current)) {
      process.stderr.write(`\nStitchDB CLI ${cache.latest} is available (you have ${current}). Update: npm install -g stitchdb-cli@latest\n`);
    }
  };
}

module.exports = { start, newer };
