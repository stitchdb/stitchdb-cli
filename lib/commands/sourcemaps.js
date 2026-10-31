// sourcemaps upload|list|delete: JavaScript source maps for crash reports (symbolicated stacks), per release.
// Uploads go straight to the project's own host (POST <api_url>/crashes/v1/sourcemaps) with the project's service key.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const U = require('../util');
const C = require('../config');
const api = require('../api');
const pkg = require('../../package.json');

const SKIP = new Set(['node_modules', '.git']);
// Every *.map under the given files / folders, with the name of the minified file it belongs to:
// <url-prefix>/<path of the file without .map, relative to the folder given>.
function findMaps(inputs, prefix = '/') {
  const out = [];
  const pre = ('/' + String(prefix || '/').replace(/^~?\/*/, '')).replace(/\/*$/, '/');
  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, base);
      else if (e.isFile() && e.name.endsWith('.map')) out.push({ file: f, name: pre + path.relative(base, f).split(path.sep).join('/').replace(/\.map$/, '') });
    }
  };
  for (const a of inputs) {
    const st = fs.statSync(a, { throwIfNoEntry: false });
    if (!st) U.fail(`${a} does not exist.`);
    if (st.isDirectory()) walk(a, a);
    else out.push({ file: a, name: pre + path.basename(a).replace(/\.map$/, '') });
  }
  return out;
}

async function target(flags) {
  const ref = C.targetRef(flags, C.project(flags, { required: false }));
  const [p, keys] = await Promise.all([api.get(`/projects/${ref}`), api.get(`/projects/${ref}/api-keys`)]);
  const key = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!key) U.fail('Uploading source maps needs the project\'s service key.', { hint: 'Use a read-write access token of a project admin (dashboard → Account → Access tokens).' });
  return { ref, url: `${String(p.api_url).replace(/\/+$/, '')}/crashes/v1/sourcemaps`, key };
}
async function call(t, method, query, body) {
  const u = new URL(t.url);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') u.searchParams.set(k, v);
  U.debug(method, u.toString());
  const res = await fetch(u, { method, headers: { apikey: t.key, Authorization: `Bearer ${t.key}`, 'User-Agent': `stitchdb-cli/${pkg.version}`,
    ...(body ? { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } : {}) }, body });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new U.CliError(data?.message || `Request failed (${res.status})`, { hint: res.status === 404 ? 'Turn on crash reporting for the project (Studio → Crashes).' : undefined });
    err.status = res.status; throw err;
  }
  return data;
}
const mb = (n) => `${(Number(n) / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB`;

module.exports = {
  'sourcemaps upload': {
    group: 'Crash reporting', summary: 'Upload JavaScript source maps of a release',
    usage: '<dist folder | .map files> --release <version> [--url-prefix <path>]',
    description: `Crash reports of that release then show the original file, line, function and source lines.
The release must be exactly what the app passes to crashes.start({ release }). Each map is stored under the path of
its minified file: the URL prefix plus the path inside the folder (dist/assets/app.js.map → /assets/app.js). A
different host or a deeper path in stack traces still matches.`,
    options: `-r, --release <version>  The app version (required)
      --url-prefix <path>      Where the folder is served from (default /)
      --name <path>            The minified file's path, for a single .map file`,
    examples: 'stitchdb sourcemaps upload dist --release 1.4.0\nstitchdb sourcemaps upload build/static/js --release "$GIT_SHA" --url-prefix /static/js',
    flags: { release: { type: 'string', alias: 'r' }, urlPrefix: { type: 'string' }, name: { type: 'string' } },
    async run({ flags, args }) {
      if (!flags.release) U.fail('Give the release: --release <version>, the same value the app sends.');
      if (!args.length) U.fail('Give the build folder or the .map files.', { hint: 'stitchdb sourcemaps upload dist --release 1.4.0' });
      const maps = findMaps(args, flags.urlPrefix);
      if (!maps.length) U.fail('No .map files found.', { hint: 'Turn on source maps in your bundler (e.g. build.sourcemap: true or devtool: "source-map").' });
      if (flags.name && maps.length === 1) maps[0].name = flags.name;
      const t = await target(flags);
      const done = [];
      for (const m of maps) {
        const r = await call(t, 'POST', { release: flags.release, name: m.name }, zlib.gzipSync(fs.readFileSync(m.file)));
        U.ok(`${m.name}  ${mb(r.size)}, ${r.sources} source${r.sources === 1 ? '' : 's'}${r.has_content ? '' : ' (no sourcesContent: no source lines)'}`);
        done.push(r);
      }
      const last = done.at(-1);
      if (last) U.log(U.c.dim(`${done.length} map${done.length === 1 ? '' : 's'} for ${flags.release}; ${mb(last.used_bytes)} of ${mb(last.limit_bytes)} used.`));
      return { release: flags.release, maps: done };
    },
  },
  'sourcemaps list': {
    group: 'Crash reporting', summary: 'List uploaded source maps',
    usage: '[--release <version>]',
    flags: { release: { type: 'string', alias: 'r' } },
    async run({ flags }) {
      const t = await target(flags);
      const r = await call(t, 'GET', { release: flags.release });
      U.output(r, () => {
        U.table(['RELEASE', 'FILE', 'SIZE', 'SOURCES', 'UPLOADED'], r.maps.map((m) => [m.release, m.name, mb(m.size), String(m.sources), U.ago(m.uploaded_at)]));
        U.log(U.c.dim(`${r.total.maps} maps in ${r.total.releases} releases, ${mb(r.total.size)} of ${mb(r.limit_bytes)}.`));
      });
      return r;
    },
  },
  'sourcemaps delete': {
    group: 'Crash reporting', summary: 'Delete the source maps of a release (or one file)',
    usage: '--release <version> [--name <path>]',
    flags: { release: { type: 'string', alias: 'r' }, name: { type: 'string' } },
    async run({ flags }) {
      if (!flags.release) U.fail('Give the release: --release <version>.');
      const t = await target(flags);
      const r = await call(t, 'DELETE', { release: flags.release, name: flags.name });
      U.ok(`Deleted ${r.deleted} map${r.deleted === 1 ? '' : 's'}.`);
      return r;
    },
  },
  _sourcemaps: { hidden: true, findMaps },
};
