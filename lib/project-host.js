// Calls to a project's own host (https://<ref>.<domain>/<module>/v1/...): crash reports, analytics, jobs, monitors,
// metering, push, search, flags. The host comes from GET /projects/:ref (api_url); the project's service key from
// GET /projects/:ref/api-keys (only read-write tokens of project admins get it).
'use strict';
const U = require('./util');
const C = require('./config');
const api = require('./api');
const pkg = require('../package.json');

const KEY_HINT = 'Use a read-write access token of a project admin (dashboard → Account → Access tokens).';

// { ref, base, key, anon }. service: false skips the keys (calls that need none, like a monitor ping).
async function target(flags, { service = true, need } = {}) {
  const ref = C.targetRef(flags, C.project(flags, { required: false }));
  const [p, keys] = await Promise.all([api.get(`/projects/${ref}`), service ? api.get(`/projects/${ref}/api-keys`) : Promise.resolve([])]);
  const key = (keys || []).find((k) => k.name === 'service_role')?.api_key || null;
  if (service && !key) U.fail(need || 'This command needs the project\'s service key.', { hint: KEY_HINT });
  if (!p?.api_url) U.fail('The project has no API URL yet.', { hint: 'Wait until the project is ready.' });
  return { ref, base: String(p.api_url).replace(/\/+$/, ''), key, anon: (keys || []).find((k) => k.name === 'anon')?.api_key || null };
}

// path: "/crashes/v1/issues". body: an object (sent as JSON), or a Buffer / string sent as is (with headers).
// feature: shown in the hint when the module answers that it is not set up ("Turn on <feature> in Studio").
// hint404: a hint for every 404 instead. raw: return the response text (CSV exports), not JSON.
async function call(t, method, path, { query, body, headers, key, feature, hint404, raw = false } = {}) {
  const u = new URL(t.base + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') u.searchParams.set(k, String(v));
  U.debug(method, u.toString());
  const k = key === undefined ? t.key : key;
  const json = body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string';
  let res;
  try {
    res = await fetch(u, { method, headers: { ...(k ? { apikey: k, Authorization: `Bearer ${k}` } : {}), 'User-Agent': `stitchdb-cli/${pkg.version}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) }, body: json ? JSON.stringify(body) : body });
  } catch (e) {
    throw new U.CliError(`Could not reach ${u.host}: ${e.cause?.code || e.message}`, { hint: 'Check your internet connection.' });
  }
  const text = await res.text();
  if (raw && res.ok) return text;
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = data?.message || data?.error || `Request failed (${res.status})`;
    const hint = res.status === 404 ? hint404 || (feature && /not set up/i.test(msg) ? `Turn on ${feature} in Studio.` : undefined)
      : res.status === 403 && /service key/i.test(msg) ? KEY_HINT : undefined;
    const err = new U.CliError(msg, { hint });
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

// A client for one module: const crashes = await client(flags, 'crashes', 'crash reporting'); crashes.get('/issues').
async function client(flags, name, feature, opts = {}) {
  const t = await target(flags, opts);
  const p = (path) => `/${name}/v1${path}`;
  return {
    t,
    get: (path, query, o) => call(t, 'GET', p(path), { query, feature, ...o }),
    post: (path, body, o) => call(t, 'POST', p(path), { body: body ?? {}, feature, ...o }),
    patch: (path, body, o) => call(t, 'PATCH', p(path), { body: body ?? {}, feature, ...o }),
    del: (path, query, o) => call(t, 'DELETE', p(path), { query, feature, ...o }),
  };
}

module.exports = { target, call, client, KEY_HINT };
