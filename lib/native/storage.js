// Local Storage service (/storage/v1): the same HTTP API as StitchDB Storage for buckets and objects, signed URLs and
// signed uploads. Rows live in storage.buckets / storage.objects and every operation runs as the caller's role, so your
// RLS policies decide exactly as on StitchDB; the files themselves are kept on disk (<data>/storage/<bucket>/<name>/<version>).
// Not available locally: image transformations (the original image is returned), resumable (TUS) and S3 uploads.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sign, verify, bearer, HttpError, readBody, readJson, send } = require('./common');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf',
  json: 'application/json', txt: 'text/plain', html: 'text/html', css: 'text/css', js: 'text/javascript', mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip', csv: 'text/csv' };
const parseSize = (s) => {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]i?b?|b)?$/i.exec(String(s).trim());
  if (!m) return null;
  const u = (m[2] || 'b').toLowerCase()[0];
  return Math.round(Number(m[1]) * ({ b: 1, k: 1024, m: 1048576, g: 1073741824 }[u] || 1));
};
const notFound = (what = 'Object') => new HttpError(404, `${what} not found`, 'not_found');

// multipart/form-data: { fields, file: {data, type, filename} }
function multipart(body, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (!m) throw new HttpError(400, 'Missing multipart boundary', 'invalid_request');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const out = { fields: {}, file: null };
  let pos = body.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (body[start] === 45 && body[start + 1] === 45) break; // closing --
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const head = body.toString('utf8', start + 2, headEnd);
    const next = body.indexOf(boundary, headEnd + 4);
    if (next < 0) break;
    const data = body.subarray(headEnd + 4, next - 2);
    const name = (/name="([^"]*)"/i.exec(head) || [])[1] ?? '';
    const filename = (/filename="([^"]*)"/i.exec(head) || [])[1];
    const type = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1];
    if (filename !== undefined || (type && !out.file && !['cacheControl', 'metadata', 'contentEncoding'].includes(name))) out.file = { data, type, filename };
    else out.fields[name] = data.toString('utf8');
    pos = next;
  }
  return out;
}

function createStorage({ db, dir, secret, apiUrl, fileLimit }) {
  const root = path.join(dir, 'storage');
  const globalLimit = parseSize(fileLimit) || 50 * 1024 * 1024;
  const claimsOf = (req) => {
    const t = bearer(req);
    const c = verify(t, secret);
    if (!c) throw new HttpError(403, t ? 'Invalid JWT (signature or expiry)' : 'No API key or JWT', 'invalid_jwt');
    return c;
  };
  const cleanName = (name) => {
    const n = String(name || '').replace(/^\/+/, '');
    if (!n || n.length > 1024 || n.split('/').some((p) => p === '..' || p === '.') || /[\x00-\x1f]/.test(n)) throw new HttpError(400, 'Invalid key', 'invalid_key');
    return n;
  };
  const fileOf = (bucket, name, version) => path.join(root, bucket, ...name.split('/'), version);
  const etag = (buf) => `"${crypto.createHash('md5').update(buf).digest('hex')}"`;

  async function bucketFor(claims, id) {
    // The bucket's limits apply to everyone (read without RLS); access to the objects is checked as the caller.
    const b = (await db.query('select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = $1', [id])).rows[0];
    if (!b) throw notFound('Bucket');
    return b;
  }
  function checkFile(b, size, type) {
    const lim = Math.min(globalLimit, b.file_size_limit ? Number(b.file_size_limit) : Infinity);
    if (size > lim) throw new HttpError(413, 'The object exceeded the maximum allowed size', 'EntityTooLarge');
    const allowed = b.allowed_mime_types;
    if (Array.isArray(allowed) || (typeof allowed === 'string' && allowed.length > 2)) {
      const list = Array.isArray(allowed) ? allowed : allowed.replace(/^\{|\}$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
      if (list.length && !list.some((a) => a === type || (a.endsWith('/*') && type.startsWith(a.slice(0, -1))))) throw new HttpError(415, `mime type ${type} is not supported`, 'invalid_mime_type');
    }
  }

  // ---------- uploads ----------
  async function upload(req, claims, bucketId, name, { upsert, update = false, owner }) {
    name = cleanName(name);
    const b = await bucketFor(claims, bucketId);
    const ctype = req.headers['content-type'] || '';
    const body = await readBody(req, globalLimit + 1024 * 1024);
    let data = body, type = ctype.split(';')[0] || 'application/octet-stream', cacheControl = req.headers['cache-control'] || 'max-age=3600', userMeta = null;
    if (/^multipart\/form-data/i.test(ctype)) {
      const mp = multipart(body, ctype);
      if (!mp.file) throw new HttpError(400, 'No file in the form', 'invalid_request');
      data = mp.file.data; type = mp.file.type || MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
      if (mp.fields.cacheControl) cacheControl = /^\d+$/.test(mp.fields.cacheControl) ? `max-age=${mp.fields.cacheControl}` : mp.fields.cacheControl;
      if (mp.fields.metadata) try { userMeta = JSON.parse(mp.fields.metadata); } catch {}
    } else if (req.headers['x-metadata']) { try { userMeta = JSON.parse(Buffer.from(String(req.headers['x-metadata']), 'base64').toString('utf8')); } catch {} }
    checkFile(b, data.length, type);
    const version = crypto.randomUUID();
    const meta = { eTag: etag(data), size: data.length, mimetype: type, cacheControl, lastModified: new Date().toISOString(), contentLength: data.length, httpStatusCode: 200 };
    const file = fileOf(bucketId, name, version);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    const sub = owner !== undefined ? owner : claims.sub || null;
    try {
      const row = await db.asRole(claims, async (q) => {
        const old = (await q('select id, version from storage.objects where bucket_id = $1 and name = $2', [bucketId, name])).rows[0];
        if (update && !old) throw notFound();
        if (old && !upsert && !update) throw new HttpError(409, 'The resource already exists', 'Duplicate');
        const r = old
          ? await q(`update storage.objects set version = $3, metadata = $4, user_metadata = $5, owner = $6::uuid, owner_id = $7, updated_at = now(), last_accessed_at = now() where bucket_id = $1 and name = $2 returning id, version`,
            [bucketId, name, version, meta, userMeta, /^[0-9a-f-]{36}$/i.test(sub || '') ? sub : null, sub])
          : await q(`insert into storage.objects (bucket_id, name, version, metadata, user_metadata, owner, owner_id) values ($1, $2, $3, $4, $5, $6::uuid, $7) returning id, version`,
            [bucketId, name, version, meta, userMeta, /^[0-9a-f-]{36}$/i.test(sub || '') ? sub : null, sub]);
        if (!r.rows[0]) throw new HttpError(403, 'new row violates row-level security policy', 'Unauthorized');
        return { ...r.rows[0], oldVersion: old?.version };
      });
      if (row.oldVersion) fs.rmSync(fileOf(bucketId, name, row.oldVersion), { force: true });
      return { Id: row.id, Key: `${bucketId}/${name}`, id: row.id, path: name, fullPath: `${bucketId}/${name}` };
    } catch (e) { fs.rmSync(file, { force: true }); throw rls(e); }
  }
  const rls = (e) => (e.code === '42501' ? new HttpError(403, 'new row violates row-level security policy', 'Unauthorized') : e);

  // ---------- downloads ----------
  async function objectRow(claims, bucketId, name, { bypass = false } = {}) {
    const run = (q) => q('select id, name, bucket_id, version, metadata, user_metadata, created_at, updated_at, last_accessed_at from storage.objects where bucket_id = $1 and name = $2', [bucketId, name]).then((r) => r.rows[0]);
    const row = bypass ? await run((s, p) => db.query(s, p)) : await db.asRole(claims, run).catch((e) => { throw rls(e); });
    if (!row) throw notFound();
    return row;
  }
  function serveFile(req, res, row, { download } = {}) {
    const file = fileOf(row.bucket_id, row.name, row.version);
    let stat;
    try { stat = fs.statSync(file); } catch { throw notFound(); }
    const m = row.metadata || {};
    const headers = { 'content-type': m.mimetype || 'application/octet-stream', 'cache-control': m.cacheControl || 'no-cache', etag: m.eTag || '', 'last-modified': new Date(row.updated_at || Date.now()).toUTCString(), 'accept-ranges': 'bytes' };
    if (download !== undefined && download !== null) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(download || row.name.split('/').pop())}"`;
    if (req.headers['if-none-match'] && req.headers['if-none-match'] === m.eTag) { res.writeHead(304, headers); return res.end(); }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }
  const info = (row) => ({ id: row.id, name: row.name, version: row.version, bucket_id: row.bucket_id, size: row.metadata?.size ?? null, content_type: row.metadata?.mimetype ?? null,
    cache_control: row.metadata?.cacheControl ?? null, etag: row.metadata?.eTag ?? null, metadata: row.user_metadata ?? null, last_modified: row.updated_at, created_at: row.created_at });

  // ---------- list ----------
  async function list(claims, bucketId, body) {
    const prefix = String(body.prefix || '').replace(/^\/+/, '');
    const pre = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 1000), offset = Math.max(Number(body.offset) || 0, 0);
    const search = String(body.search || '');
    const col = ['name', 'updated_at', 'created_at', 'last_accessed_at'].includes(body.sortBy?.column) ? body.sortBy.column : 'name';
    const dir = String(body.sortBy?.order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const rows = await db.asRole(claims, (q) => q(`
      with o as (select * from storage.objects where bucket_id = $1 and name like $2 escape '\\'),
      items as (
        select split_part(substr(name, length($3) + 1), '/', 1) as item, bool_or(position('/' in substr(name, length($3) + 1)) > 0) as folder
        from o group by 1)
      select i.item as name, i.folder, x.id, x.updated_at, x.created_at, x.last_accessed_at, x.metadata
      from items i left join o x on not i.folder and x.name = $3 || i.item
      where i.item ilike $4
      order by ${col === 'name' ? 'i.item' : `x.${col}`} ${dir} nulls last, i.item limit $5 offset $6`,
    [bucketId, pre.replace(/[\\%_]/g, '\\$&') + '%', pre, `${search.replace(/[\\%_]/g, '\\$&')}%`, limit, offset])).catch((e) => { throw rls(e); });
    return rows.rows.map((r) => (r.folder && !r.id
      ? { name: r.name, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null }
      : { name: r.name, id: r.id, updated_at: r.updated_at, created_at: r.created_at, last_accessed_at: r.last_accessed_at, metadata: r.metadata }));
  }
  async function listV2(claims, bucketId, body) {
    const prefix = String(body.prefix || '').replace(/^\/+/, '');
    const limit = Math.min(Math.max(Number(body.limit) || 1000, 1), 1000);
    const cursor = body.cursor ? Buffer.from(String(body.cursor), 'base64url').toString('utf8') : '';
    const delim = body.with_delimiter !== false;
    const r = await db.asRole(claims, (q) => q(`select id, name, updated_at, created_at, last_accessed_at, metadata from storage.objects
      where bucket_id = $1 and name like $2 escape '\\' and name > $3 order by name limit 100000`, [bucketId, prefix.replace(/[\\%_]/g, '\\$&') + '%', cursor])).catch((e) => { throw rls(e); });
    const folders = new Map(), objects = [];
    let last = null, more = false;
    for (const o of r.rows) {
      const rest = o.name.slice(prefix.length);
      const slash = delim ? rest.indexOf('/') : -1;
      if (folders.size + objects.length >= limit) { more = true; break; }
      if (slash >= 0) { const key = prefix + rest.slice(0, slash + 1); if (!folders.has(key)) folders.set(key, { key, name: rest.slice(0, slash + 1) }); last = key + '\uffff'; continue; }
      objects.push({ id: o.id, key: o.name, name: rest, updated_at: o.updated_at, created_at: o.created_at, last_accessed_at: o.last_accessed_at, metadata: o.metadata });
      last = o.name;
    }
    // A folder's keys are skipped as a whole on the next page.
    return { hasNext: more, folders: [...folders.values()], objects, nextCursor: more && last ? Buffer.from(last).toString('base64url') : undefined };
  }

  // ---------- delete / move / copy ----------
  async function remove(claims, bucketId, names) {
    const rows = await db.asRole(claims, (q) => q('delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning id, name, bucket_id, version, metadata, created_at, updated_at, last_accessed_at',
      [bucketId, `{${names.map((n) => `"${String(n).replace(/["\\]/g, '\\$&')}"`).join(',')}}`])).catch((e) => { throw rls(e); });
    for (const r of rows.rows) fs.rmSync(fileOf(r.bucket_id, r.name, r.version), { force: true });
    return rows.rows.map((r) => ({ ...r, owner: null }));
  }
  async function move(claims, b, copy) {
    const from = cleanName(b.sourceKey), to = cleanName(b.destinationKey), src = b.bucketId, dst = b.destinationBucket || b.bucketId;
    if (!src) throw new HttpError(400, 'bucketId is required', 'invalid_request');
    await bucketFor(claims, dst);
    return db.asRole(claims, async (q) => {
      const row = (await q('select id, version, metadata, user_metadata from storage.objects where bucket_id = $1 and name = $2', [src, from])).rows[0];
      if (!row) throw notFound();
      const exists = (await q('select 1 from storage.objects where bucket_id = $1 and name = $2', [dst, to])).rows[0];
      if (exists) throw new HttpError(409, 'The resource already exists', 'Duplicate');
      const version = crypto.randomUUID();
      const target = fileOf(dst, to, version);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (copy) {
        fs.copyFileSync(fileOf(src, from, row.version), target);
        const r = await q(`insert into storage.objects (bucket_id, name, version, metadata, user_metadata, owner, owner_id) values ($1, $2, $3, $4, $5, $6::uuid, $7) returning id`,
          [dst, to, version, row.metadata, row.user_metadata, /^[0-9a-f-]{36}$/i.test(claims.sub || '') ? claims.sub : null, claims.sub || null]).catch((e) => { fs.rmSync(target, { force: true }); throw rls(e); });
        return { Key: `${dst}/${to}`, Id: r.rows[0].id, id: r.rows[0].id, path: to, fullPath: `${dst}/${to}` };
      }
      const r = await q('update storage.objects set bucket_id = $3, name = $4, version = $5, updated_at = now() where bucket_id = $1 and name = $2 returning id', [src, from, dst, to, version]).catch((e) => { throw rls(e); });
      if (!r.rows[0]) throw notFound();
      fs.renameSync(fileOf(src, from, row.version), target);
      return { message: 'Successfully moved' };
    });
  }

  // ---------- signed URLs ----------
  const signUrl = (bucketId, name, expiresIn, transform) => {
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Number(expiresIn) || 60);
    const token = sign({ url: `${bucketId}/${name}`, iat: Math.floor(Date.now() / 1000), exp, ...(transform ? { transformations: transform } : {}) }, secret);
    return `/object/sign/${bucketId}/${name.split('/').map(encodeURIComponent).join('/')}?token=${token}`;
  };

  // ---------- buckets ----------
  const bucketOut = (b) => ({ id: b.id, name: b.name, owner: b.owner ?? '', public: b.public, file_size_limit: b.file_size_limit === null ? null : Number(b.file_size_limit), allowed_mime_types: b.allowed_mime_types, type: b.type, created_at: b.created_at, updated_at: b.updated_at });
  const mimeArr = (a) => (Array.isArray(a) && a.length ? `{${a.map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')}}` : null);

  async function handle(req, res, sub) {
    const url = new URL(sub, 'http://local');
    const p = decodeURIComponent(url.pathname);
    const m = req.method;
    const qs = url.searchParams;
    if (p === '/status' || p === '/health') return send(res, 200, { status: 'ok', local: true });
    if (p.startsWith('/upload/resumable') || p.startsWith('/s3')) throw new HttpError(501, 'Resumable (TUS) and S3 uploads are not available in local development; use the normal upload', 'not_implemented');

    // Public and signed reads need no JWT.
    let r;
    if ((r = /^\/(?:object|render\/image)\/public\/([^/]+)\/(.+)$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
      const b = (await db.query('select public from storage.buckets where id = $1', [r[1]])).rows[0];
      if (!b || !b.public) throw notFound(b ? 'Object' : 'Bucket');
      return serveFile(req, res, await objectRow(null, r[1], r[2], { bypass: true }), { download: qs.get('download') });
    }
    if ((r = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
      const t = verify(qs.get('token'), secret);
      if (!t || t.url !== `${r[1]}/${r[2]}`) throw new HttpError(400, 'Invalid or expired signature', 'InvalidSignature');
      return serveFile(req, res, await objectRow(null, r[1], r[2], { bypass: true }), { download: qs.get('download') });
    }
    if ((r = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p)) && m === 'PUT') {
      const t = verify(qs.get('token'), secret);
      if (!t || t.url !== `${r[1]}/${r[2]}` || !t.upload) throw new HttpError(400, 'Invalid or expired signature', 'InvalidSignature');
      const out = await upload(req, { role: 'service_role' }, r[1], r[2], { upsert: !!t.upsert, owner: t.owner || null });
      return send(res, 200, { Key: out.Key, Id: out.Id, path: out.path, fullPath: out.fullPath });
    }
    if ((r = /^\/object\/info\/public\/([^/]+)\/(.+)$/.exec(p)) && m === 'GET') {
      const b = (await db.query('select public from storage.buckets where id = $1', [r[1]])).rows[0];
      if (!b || !b.public) throw notFound();
      return send(res, 200, info(await objectRow(null, r[1], r[2], { bypass: true })));
    }

    const claims = claimsOf(req);
    if (p === '/bucket' && m === 'GET') {
      const rows = await db.asRole(claims, (q) => q(`select * from storage.buckets ${qs.get('search') ? 'where name ilike $1' : ''} order by name`, qs.get('search') ? [`%${qs.get('search')}%`] : undefined));
      return send(res, 200, rows.rows.map(bucketOut));
    }
    if (p === '/bucket' && m === 'POST') {
      const b = await readJson(req);
      const id = String(b.id || b.name || '');
      if (!/^[A-Za-z0-9_.\- ]{1,100}$/.test(id)) throw new HttpError(400, 'Bucket names use letters, digits, spaces and . _ -', 'InvalidBucketName');
      await db.asRole(claims, (q) => q('insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types, owner, owner_id) values ($1, $2, $3, $4, $5, $6::uuid, $7)',
        [id, String(b.name || id), !!b.public, parseSize(b.file_size_limit ?? b.fileSizeLimit), mimeArr(b.allowed_mime_types ?? b.allowedMimeTypes), /^[0-9a-f-]{36}$/i.test(claims.sub || '') ? claims.sub : null, claims.sub || null]))
        .catch((e) => { if (e.code === '23505') throw new HttpError(409, 'The resource already exists', 'Duplicate'); throw rls(e); });
      return send(res, 200, { name: id });
    }
    if ((r = /^\/bucket\/([^/]+)$/.exec(p))) {
      const id = r[1];
      if (m === 'GET') {
        const row = (await db.asRole(claims, (q) => q('select * from storage.buckets where id = $1', [id]))).rows[0];
        if (!row) throw notFound('Bucket');
        return send(res, 200, bucketOut(row));
      }
      if (m === 'PUT') {
        const b = await readJson(req);
        const u = await db.asRole(claims, (q) => q(`update storage.buckets set public = coalesce($2, public), file_size_limit = case when $5 then $3 else file_size_limit end,
          allowed_mime_types = case when $6 then $4::text[] else allowed_mime_types end, updated_at = now() where id = $1 returning id`,
        [id, b.public === undefined ? null : !!b.public, parseSize(b.file_size_limit ?? b.fileSizeLimit), mimeArr(b.allowed_mime_types ?? b.allowedMimeTypes),
          'file_size_limit' in b || 'fileSizeLimit' in b, 'allowed_mime_types' in b || 'allowedMimeTypes' in b])).catch((e) => { throw rls(e); });
        if (!u.rows[0]) throw notFound('Bucket');
        return send(res, 200, { message: 'Successfully updated' });
      }
      if (m === 'DELETE') {
        const n = (await db.query('select count(*)::int n from storage.objects where bucket_id = $1', [id])).rows[0].n;
        if (n) throw new HttpError(409, 'The bucket you tried to delete is not empty', 'InvalidRequest');
        const d = await db.asRole(claims, (q) => q('delete from storage.buckets where id = $1 returning id', [id])).catch((e) => { throw rls(e); });
        if (!d.rows[0]) throw notFound('Bucket');
        fs.rmSync(path.join(root, id), { recursive: true, force: true });
        return send(res, 200, { message: 'Successfully deleted' });
      }
    }
    if ((r = /^\/bucket\/([^/]+)\/empty$/.exec(p)) && m === 'POST') {
      const names = (await db.asRole(claims, (q) => q('select name from storage.objects where bucket_id = $1', [r[1]]))).rows.map((x) => x.name);
      if (names.length) await remove(claims, r[1], names);
      return send(res, 200, { message: 'Successfully emptied' });
    }

    if ((r = /^\/object\/list\/([^/]+)$/.exec(p)) && m === 'POST') return send(res, 200, await list(claims, r[1], await readJson(req)));
    if ((r = /^\/object\/list-v2\/([^/]+)$/.exec(p)) && m === 'POST') return send(res, 200, await listV2(claims, r[1], await readJson(req)));
    if (p === '/object/move' && m === 'POST') return send(res, 200, await move(claims, await readJson(req), false));
    if (p === '/object/copy' && m === 'POST') return send(res, 200, await move(claims, await readJson(req), true));
    if ((r = /^\/object\/sign\/([^/]+)$/.exec(p)) && m === 'POST') {
      const b = await readJson(req);
      const paths = Array.isArray(b.paths) ? b.paths : [];
      const have = new Set((await db.asRole(claims, (q) => q('select name from storage.objects where bucket_id = $1 and name = any($2::text[])', [r[1], `{${paths.map((n) => `"${String(n).replace(/["\\]/g, '\\$&')}"`).join(',')}}`]))).rows.map((x) => x.name));
      return send(res, 200, paths.map((n) => (have.has(n) ? { error: null, path: n, signedURL: signUrl(r[1], n, b.expiresIn) } : { error: 'Either the object does not exist or you do not have access to it', path: n, signedURL: null })));
    }
    if ((r = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(p)) && m === 'POST') {
      const b = await readJson(req);
      await objectRow(claims, r[1], r[2]);
      return send(res, 200, { signedURL: signUrl(r[1], r[2], b.expiresIn, b.transform) });
    }
    if ((r = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p)) && m === 'POST') {
      const name = cleanName(r[2]);
      await bucketFor(claims, r[1]);
      // As on StitchDB, creating the signed upload checks that the caller may insert the object.
      await db.asRole(claims, async (q) => {
        await q('savepoint s');
        await q(`insert into storage.objects (bucket_id, name, owner, owner_id) values ($1, $2, $3::uuid, $4)`, [r[1], name, /^[0-9a-f-]{36}$/i.test(claims.sub || '') ? claims.sub : null, claims.sub || null])
          .catch((e) => { if (e.code === '23505' && req.headers['x-upsert'] === 'true') return null; if (e.code === '23505') throw new HttpError(409, 'The resource already exists', 'Duplicate'); throw rls(e); });
        await q('rollback to savepoint s');
      });
      const token = sign({ url: `${r[1]}/${name}`, upload: true, upsert: req.headers['x-upsert'] === 'true', owner: claims.sub || null, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 }, secret);
      return send(res, 200, { url: `/object/upload/sign/${r[1]}/${name.split('/').map(encodeURIComponent).join('/')}?token=${token}`, token });
    }
    if ((r = /^\/object\/info\/(?:authenticated\/)?([^/]+)\/(.+)$/.exec(p)) && m === 'GET') return send(res, 200, info(await objectRow(claims, r[1], r[2])));
    if ((r = /^\/(?:object|render\/image)\/(?:authenticated\/)?([^/]+)\/(.+)$/.exec(p)) && (m === 'GET' || m === 'HEAD')) return serveFile(req, res, await objectRow(claims, r[1], r[2]), { download: qs.get('download') });
    if ((r = /^\/object\/([^/]+)\/(.+)$/.exec(p)) && (m === 'POST' || m === 'PUT')) {
      return send(res, 200, await upload(req, claims, r[1], r[2], { upsert: m === 'POST' ? req.headers['x-upsert'] === 'true' : false, update: m === 'PUT' }));
    }
    if ((r = /^\/object\/([^/]+)\/(.+)$/.exec(p)) && m === 'DELETE') {
      const d = await remove(claims, r[1], [r[2]]);
      if (!d.length) throw notFound();
      return send(res, 200, { message: 'Successfully deleted' });
    }
    if ((r = /^\/object\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      const b = await readJson(req);
      return send(res, 200, await remove(claims, r[1], Array.isArray(b.prefixes) ? b.prefixes : []));
    }
    if (p.startsWith('/cdn/')) return send(res, 200, { message: 'success' });
    throw new HttpError(404, 'Route not found', 'not_found');
  }

  return {
    async handle(req, res, sub) {
      try { await handle(req, res, sub); }
      catch (e) {
        const status = e.status || (e.code === '22P02' ? 400 : 500);
        if (status >= 500) process.stderr.write(`storage: ${e.stack || e.message}\n`);
        send(res, status, { statusCode: String(status), error: e.code || (status === 404 ? 'not_found' : 'error'), message: e.message });
      }
    },
  };
}

module.exports = { createStorage, multipart, parseSize };
