// The native local runtime: the programs `stitchdb start` runs as plain processes (no Docker), downloaded once per
// version into ~/.stitchdb/runtime and checked against pinned SHA-256 sums.
//   stitchdb-runtime-<platform>.tar.gz  Postgres 17 (contrib, pgvector, pg_cron), the REST server and the auth server,
//                                       built by .github/workflows/runtime.yml in this repository.
//   Deno (official release zip)         Edge Functions; only downloaded the first time functions run, and not at all
//                                       when a Deno 2 is already installed.
// STITCHDB_RUNTIME_DIR points at an unpacked runtime instead (CI, offline machines, testing a new build).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { fail, debug } = require('./util');
const { HOME } = require('./config');

const RUNTIME = {
  version: '1',
  base: 'https://github.com/stitchdb/stitchdb-cli/releases/download/runtime-v1',
  // Filled in from the release's runtime-manifest.json: {platform: sha256}.
  sha256: {
    'darwin-arm64': 'cb02abee579ff86de687225d220e36072c842e206f2e4779925249fc3d52d4cb',
    'darwin-x64': 'fd62a5fe5824ad9f104ab8ceae2568f2f4993521e6d61c91fd4c64d1830f08c8',
    'linux-arm64': '0f6a669175cbd81ec82d4ca1a1444ae6ad81fbfe1b7366055b9a0809f149b83c',
    'linux-x64': 'faf88edc439a730420e70f43d687aea7189d1d7e51a6d688cdebc332e79cf384',
  },
};
const DENO = {
  version: '2.9.8',
  target: { 'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu', 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin' },
  sha256: {
    'linux-x64': 'e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609',
    'linux-arm64': 'd49596c20b9788cf8f5d8ddf644103d4bde56ed239753f0bdb92ba9361d51905',
    'darwin-arm64': '9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e',
    'darwin-x64': '4b2f5edd2639b7470f034238b321d7002d8dfb4726d8558f52c17afac370eb2c',
  },
};
// As root (CI containers), Postgres runs as "nobody" and must reach its files: a private home folder moves the runtime
// and the local databases to /var/tmp/stitchdb.
function dataHome() {
  if (process.env.STITCHDB_HOME || typeof process.getuid !== 'function' || process.getuid() !== 0) return HOME;
  try { if ((fs.statSync(require('os').homedir()).mode & 0o001) === 0) return '/var/tmp/stitchdb'; } catch {}
  return HOME;
}
const ROOT = path.join(dataHome(), 'runtime');

function platform() {
  const p = `${process.platform}-${process.arch}`;
  if (process.platform === 'win32') fail('Local development runs on macOS and Linux.', { hint: 'On Windows, run the CLI inside WSL (Windows Subsystem for Linux).' });
  if (!DENO.target[p]) fail(`Local development is not available for ${p} yet (macOS and Linux on x64 or arm64).`);
  return p;
}

async function download(url, file, sha256, label, progress) {
  debug('download', url);
  const res = await fetch(url, { redirect: 'follow' }).catch((e) => fail(`Could not download ${label}: ${e.message}`, { hint: 'Check your internet connection, or set STITCHDB_RUNTIME_DIR to an unpacked runtime.' }));
  if (!res.ok) fail(`Could not download ${label} (${res.status} from ${new URL(url).host}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const tmp = `${file}.part${process.pid}`;
  const out = fs.createWriteStream(tmp);
  let got = 0, last = 0;
  for await (const chunk of res.body) {
    hash.update(chunk); got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (progress && Date.now() - last > 250) { last = Date.now(); progress(got, total); }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  const sum = hash.digest('hex');
  if (sha256 && sum !== sha256) { fs.rmSync(tmp, { force: true }); fail(`The download of ${label} is damaged or changed (SHA-256 ${sum.slice(0, 12)}…, expected ${sha256.slice(0, 12)}…).`, { hint: 'Try again; if it keeps happening, update the CLI.' }); }
  fs.renameSync(tmp, file);
  return sum;
}

// A zip with one or a few files (the Deno release): stored or deflated entries, via the central directory.
function unzip(file, dest) {
  const b = fs.readFileSync(file);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) fail('The downloaded archive is not a zip file.');
  const n = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42), name = b.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.includes('..')) continue;
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + csize);
    const target = path.join(dest, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, method === 8 ? zlib.inflateRawSync(data) : data, { mode: 0o755 });
  }
}

const say = (s) => process.stderr.write(s);
function bar(label) {
  if (!process.stderr.isTTY || require('./util').state.json) return null;
  return (got, total) => say(`\r› Downloading ${label}: ${(got / 1048576).toFixed(1)}${total ? ` of ${(total / 1048576).toFixed(1)}` : ''} MB\x1b[K`);
}

// The unpacked runtime: { dir, pg: <dir with bin/lib/share>, bin(name), version }.
async function ensure() {
  const env = process.env.STITCHDB_RUNTIME_DIR;
  const dir = env ? path.resolve(env) : path.join(ROOT, `runtime-${RUNTIME.version}-${platform()}`);
  if (!fs.existsSync(path.join(dir, 'VERSION.json'))) {
    if (env) fail(`STITCHDB_RUNTIME_DIR (${env}) is not an unpacked StitchDB runtime (no VERSION.json).`);
    const p = platform();
    fs.mkdirSync(ROOT, { recursive: true });
    let sha = RUNTIME.sha256[p];
    if (!sha) {
      // Builds without pinned sums take them from the release manifest (same origin as the files).
      const m = await fetch(`${RUNTIME.base}/runtime-manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      sha = m?.[p]?.sha256;
      if (!sha) fail(`The local runtime ${RUNTIME.version} for ${p} is not available for download yet.`, { hint: 'Set STITCHDB_RUNTIME_DIR to an unpacked runtime, or update the CLI.' });
    }
    const tgz = path.join(ROOT, `stitchdb-runtime-${RUNTIME.version}-${p}.tar.gz`);
    const show = bar('the local runtime (once)');
    await download(`${RUNTIME.base}/stitchdb-runtime-${p}.tar.gz`, tgz, sha, 'the local runtime', show);
    if (show) say('\r\x1b[K');
    const tmp = `${dir}.tmp${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const r = spawnSync('tar', ['-xzf', tgz, '-C', tmp], { encoding: 'utf8' });
    if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); fail(`Could not unpack the local runtime: ${(r.stderr || r.error?.message || '').trim()}`); }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    fs.rmSync(tgz, { force: true });
  }
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'VERSION.json'), 'utf8'));
  return { dir, version, pg: path.join(dir, 'pg'), pgBin: (n) => path.join(dir, 'pg', 'bin', n), bin: (n) => path.join(dir, 'bin', n), authMigrations: path.join(dir, 'auth', 'migrations') };
}

// Deno for Edge Functions: STITCHDB_DENO, else a Deno 2 on PATH, else the pinned release (downloaded on first use).
async function deno() {
  if (process.env.STITCHDB_DENO) return process.env.STITCHDB_DENO;
  const onPath = spawnSync('deno', ['--version'], { encoding: 'utf8' });
  if (onPath.status === 0 && /^deno 2\./m.test(onPath.stdout)) return 'deno';
  const p = platform();
  const dir = path.join(ROOT, `deno-${DENO.version}-${p}`);
  const bin = path.join(dir, 'deno');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(ROOT, { recursive: true });
  const zip = path.join(ROOT, `deno-${DENO.version}-${p}.zip`);
  const show = bar('Deno for Edge Functions (once)');
  await download(`https://github.com/denoland/deno/releases/download/v${DENO.version}/deno-${DENO.target[p]}.zip`, zip, DENO.sha256[p], 'Deno', show);
  if (show) say('\r\x1b[K');
  const tmp = `${dir}.tmp${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  unzip(zip, tmp);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  fs.rmSync(zip, { force: true });
  return bin;
}

module.exports = { dataHome, ensure, deno, platform, RUNTIME, DENO, ROOT, unzip, download };
