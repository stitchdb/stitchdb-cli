// HTTP client for the StitchDB management API (/platform/v1). Uses Node's built-in fetch (Node >= 18).
'use strict';
const { apiUrl, accessToken } = require('./config');
const { CliError, debug } = require('./util');
const pkg = require('../package.json');

async function request(method, path, { body, token, raw = false, query } = {}) {
  const base = apiUrl();
  const url = new URL(`${base}/platform/v1${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token || accessToken()}`, 'User-Agent': `stitchdb-cli/${pkg.version} node/${process.versions.node}`, Accept: raw ? '*/*' : 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  debug(method, url.toString());
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
      throw new CliError(`Could not reach ${base}: ${e.cause?.code || e.message}`, { hint: 'Check your internet connection (or STITCHDB_API_URL).' });
    }
    if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * (attempt + 1);
      debug('retry after', wait, 'ms (status', res.status + ')');
      await new Promise((r) => setTimeout(r, wait)); continue;
    }
    break;
  }
  if (raw && res.ok) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = data?.error || data?.message || `Request failed (${res.status})`;
    const hint = res.status === 401 ? 'Your access token is invalid or expired. Run "stitchdb login" again.'
      : res.status === 404 && /project/i.test(msg) ? 'Check the project reference, and that your account (or token) can access it.'
      : res.status === 403 && /read-only/i.test(msg) ? 'Create a read-write access token in the dashboard (Account → Access tokens).' : undefined;
    const err = new CliError(msg, { hint });
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

const api = {
  get: (p, o) => request('GET', p, o), post: (p, body, o) => request('POST', p, { ...o, body: body ?? {} }),
  del: (p, o) => request('DELETE', p, o), patch: (p, body, o) => request('PATCH', p, { ...o, body }), request,
};
module.exports = api;
