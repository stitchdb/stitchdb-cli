// Credentials (~/.stitchdb/credentials), the project folder (./stitchdb), its config.toml and the linked project.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const toml = require('./toml');
const { fail, exists, writeFileSafe } = require('./util');

const HOME = process.env.STITCHDB_HOME || path.join(os.homedir(), '.stitchdb');
const CRED = path.join(HOME, 'credentials');
const DIR = 'stitchdb';

// ---------- credentials ----------
function readCredentials() {
  try { return JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch { return {}; }
}
function saveCredentials(obj) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSafe(CRED, JSON.stringify(obj, null, 2) + '\n', 0o600);
}
function removeCredentials() { try { fs.unlinkSync(CRED); return true; } catch { return false; } }
const apiUrl = () => (process.env.STITCHDB_API_URL || readCredentials().api_url || 'https://stitchdb.com').replace(/\/+$/, '');
function accessToken({ required = true } = {}) {
  const t = process.env.STITCHDB_ACCESS_TOKEN || readCredentials().access_token;
  if (!t && required) fail('You are not logged in.', { hint: 'Run "stitchdb login", or set STITCHDB_ACCESS_TOKEN (CI).' });
  return t || null;
}

// ---------- project folder ----------
// The folder that contains stitchdb/config.toml: --workdir, else the current folder or the nearest parent.
function findRoot(workdir) {
  let d = path.resolve(workdir || process.cwd());
  for (;;) {
    if (exists(path.join(d, DIR, 'config.toml'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}
function project(flags = {}, { required = true } = {}) {
  const root = findRoot(flags.workdir);
  if (!root) {
    if (required) fail('No stitchdb/config.toml found in this folder or its parents.', { hint: 'Run "stitchdb init" in your app folder first.' });
    return null;
  }
  const dir = path.join(root, DIR);
  let cfg = {};
  try { cfg = toml.parse(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')); } catch (e) { fail(e.message); }
  const temp = path.join(dir, '.temp');
  const readTemp = (f) => { try { return fs.readFileSync(path.join(temp, f), 'utf8').trim() || null; } catch { return null; } };
  return {
    root, dir, temp, cfg,
    id: String(cfg.project_id || path.basename(root)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app',
    migrationsDir: path.join(dir, 'migrations'), functionsDir: path.join(dir, 'functions'), seedFile: path.join(dir, cfg.db?.seed?.sql_path || 'seed.sql'),
    linkedRef: readTemp('project-ref'), branchRef: readTemp('branch-ref'), branchName: readTemp('branch-name'),
    writeTemp(f, v) { if (v == null) { try { fs.unlinkSync(path.join(temp, f)); } catch {} return; } writeFileSafe(path.join(temp, f), String(v) + '\n'); },
  };
}
// The project a remote command works on: --project-ref, else the switched-to branch, else the linked project.
function targetRef(flags, proj, { allowBranch = true } = {}) {
  const ref = flags.projectRef || (allowBranch && proj?.branchRef) || proj?.linkedRef || process.env.STITCHDB_PROJECT_REF;
  if (!ref) fail('No project selected.', { hint: 'Run "stitchdb link --project-ref <ref>", or pass --project-ref.' });
  if (!/^[a-z]{16}$/.test(ref)) fail(`"${ref}" is not a project reference (16 lowercase letters).`);
  return ref;
}

module.exports = { HOME, CRED, DIR, readCredentials, saveCredentials, removeCredentials, apiUrl, accessToken, findRoot, project, targetRef };
