/**
 * stg-agpl-spreadsheet — Amplify STAGING ONLY. Isolated service for the AGPL-3.0-only Spreadsheet app.
 *
 * Copyright (c) 2026 Guðmundur Eyberg Kristjánsson (Amplify). Part of the corresponding source of a modified
 * version of the Spreadsheet app (Copyright (c) 2026 Puter Technologies Inc.); licensed AGPL-3.0-only.
 * Source: https://github.com/amplify-is/agpl-office-apps (apps/spreadsheet), tag = SOURCE_TAG.
 *
 *   auth     Cloudflare Access (team amplify-staging, policy staging-allow-owner) on the whole host; this Worker re-verifies
 *            Cf-Access-Jwt-Assertion (RS256, iss, aud, exp, email) and fails closed. /license and /source are public
 *            (the AGPL offer must reach every network user) through a path-scoped Access bypass and the exemption below.
 *   kv       D1 stg-agpl-spreadsheet table kv          fs  D1 table files (metadata, ids) + R2 stg-agpl-spreadsheet (bytes by id)
 *   flag     SPREADSHEET_ENABLED must be "1" (default "0"), else 503 except /health, /license, /source
 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MAX_KV_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const KEY_RE = /^[\x21-\x7e]{1,256}$/;
const REPO = 'https://github.com/amplify-is/agpl-office-apps';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const fail = (status, code, message) => json({ code, message }, status);

function finish(res, env, { html = false } = {}) {
  const h = new Headers(res.headers);
  h.set('x-robots-tag', 'noindex, nofollow');
  h.set('x-amplify-env', 'staging-test');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'same-origin');
  h.set('x-source-offer', sourceUrl(env));
  if (html) h.set('x-frame-options', 'SAMEORIGIN');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
const sourceUrl = (env) => `${REPO}/tree/${encodeURIComponent(env.SOURCE_TAG || 'main')}/apps/spreadsheet`;

// ---------------------------------------------------------------- Access JWT
let certCache = { at: 0, keys: null };
const b64urlBytes = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
async function accessKeys(teamDomain, force = false) {
  if (!force && certCache.keys && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  certCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  return certCache.keys;
}
export async function verifyAccess(request, env) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (!(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).includes(env.ACCESS_AUD)) return null;
  for (const force of [false, true]) {
    const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN, force)).find((k) => k.kid === header.kid);
    if (!jwk) continue;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) return null;
    const email = String(payload.email || '').toLowerCase();
    const allowed = String(env.ALLOWED_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    if (!email || (allowed.length && !allowed.includes(email))) return null;
    return { email };
  }
  return null;
}
async function userIdOf(email) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`agpl-spreadsheet:${email}`));
  return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- paths
// Relative drive paths as the app writes them (Spreadsheets/Budget.xlsx, Spreadsheets/.versions/...). No absolute paths,
// no "." / ".." segments, no control characters or backslashes.
export function cleanPath(p) {
  const s = String(p ?? '').normalize('NFC').replace(/\/+$/, '');
  if (!s || s.length > 1024 || s.startsWith('/') || s.startsWith('~') || /[\\\u0000-\u001f\u007f]/.test(s)) return null;
  const segs = s.split('/');
  if (segs.some((g) => !g || g === '.' || g === '..' || g.length > 255)) return null;
  return s;
}
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const blobKey = (uid, id) => `u/${uid}/${id}`;
const item = (r) => r && ({ uid: r.id, id: r.id, name: nameOf(r.path), path: r.path, is_dir: !!r.is_dir, size: r.size || 0, modified: Math.floor(r.modified / 1000), created: Math.floor(r.created / 1000) });
const escLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function rowOf(env, uid, q) {
  if (q.uid) return env.DB.prepare('SELECT * FROM files WHERE user_id = ? AND id = ?').bind(uid, String(q.uid)).first();
  const path = cleanPath(q.path);
  if (!path) throw Object.assign(new Error('Bad path'), { status: 400 });
  return env.DB.prepare('SELECT * FROM files WHERE user_id = ? AND path = ?').bind(uid, path).first();
}
async function ensureDirs(env, uid, path) {
  const now = Date.now();
  const segs = path.split('/');
  for (let i = 1; i < segs.length; i++) {
    const dir = segs.slice(0, i).join('/');
    await env.DB.prepare('INSERT INTO files (user_id, path, id, is_dir, size, created, modified) VALUES (?, ?, ?, 1, 0, ?, ?) ON CONFLICT(user_id, path) DO NOTHING')
      .bind(uid, dir, crypto.randomUUID(), now, now).run();
  }
}
const notFound = (what) => fail(404, 'subject_does_not_exist', `No such file: ${what}`);
const query = (url) => ({ path: url.searchParams.get('path'), uid: url.searchParams.get('uid') });

async function readJson(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_KV_BYTES + 4096) throw Object.assign(new Error('too large'), { status: 413 });
  try { return await request.json(); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

async function api(request, env, url, uid, email) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return fail(403, 'forbidden', 'Cross-origin request refused');
  const route = url.pathname.slice(4);
  const DB = env.DB;
  switch (route) {
    case '/me': return json({ username: email.split('@')[0], uuid: uid, email });
    case '/kv/get': {
      const { key } = await readJson(request);
      if (!KEY_RE.test(String(key))) return fail(400, 'bad_key', 'Bad key');
      const row = await DB.prepare('SELECT value FROM kv WHERE user_id = ? AND key = ?').bind(uid, key).first();
      return json({ value: row ? row.value : null });
    }
    case '/kv/set': {
      const { key, value } = await readJson(request);
      if (!KEY_RE.test(String(key))) return fail(400, 'bad_key', 'Bad key');
      const v = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      if (v.length > MAX_KV_BYTES) return fail(413, 'too_large', 'Value too large');
      await DB.prepare('INSERT INTO kv (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(uid, key, v, Date.now()).run();
      return json({ ok: true });
    }
    case '/kv/del': {
      const { key } = await readJson(request);
      if (!KEY_RE.test(String(key))) return fail(400, 'bad_key', 'Bad key');
      await DB.prepare('DELETE FROM kv WHERE user_id = ? AND key = ?').bind(uid, key).run();
      return json({ ok: true });
    }
    case '/fs/read': {
      const row = await rowOf(env, uid, query(url));
      if (!row || row.is_dir) return notFound(url.searchParams.get('path') || 'file');
      const obj = await env.FILES.get(blobKey(uid, row.id));
      if (!obj) return notFound(row.path);
      return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }
    case '/fs/stat': {
      const row = await rowOf(env, uid, query(url));
      return row ? json(item(row)) : notFound(url.searchParams.get('path') || 'file');
    }
    case '/fs/mkdir': {
      const path = cleanPath(url.searchParams.get('path'));
      if (!path) return fail(400, 'bad_path', 'Bad path');
      await ensureDirs(env, uid, `${path}/x`);
      return json(item(await rowOf(env, uid, { path })));
    }
    case '/fs/readdir': {
      const path = cleanPath(url.searchParams.get('path'));
      if (!path) return fail(400, 'bad_path', 'Bad path');
      const dir = await rowOf(env, uid, { path });
      if (!dir || !dir.is_dir) return notFound(path);
      const { results } = await DB.prepare("SELECT * FROM files WHERE user_id = ? AND path LIKE ? ESCAPE '\\' AND instr(substr(path, ?), '/') = 0")
        .bind(uid, `${escLike(path)}/%`, path.length + 2).all();
      return json({ items: results.map(item) });
    }
    case '/fs/write': {
      let path = cleanPath(url.searchParams.get('path'));
      if (!path) return fail(400, 'bad_path', 'Bad path');
      if (Number(request.headers.get('content-length') || 0) > MAX_FILE_BYTES) return fail(413, 'too_large', 'File too large');
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_FILE_BYTES) return fail(413, 'too_large', 'File too large');
      let existing = await rowOf(env, uid, { path });
      if (existing && url.searchParams.get('dedupe') === '1') {
        const dot = nameOf(path).lastIndexOf('.');
        const stem = dot > 0 ? path.slice(0, path.length - nameOf(path).length + dot) : path;
        const ext = dot > 0 ? nameOf(path).slice(dot) : '';
        for (let n = 1; existing && n < 1000; n++) { path = `${stem} (${n})${ext}`; existing = await rowOf(env, uid, { path }); }
        if (existing) return fail(409, 'item_with_same_name_exists', 'Too many files with that name');
      }
      if (existing && existing.is_dir) return fail(409, 'item_with_same_name_exists', 'A folder has that name');
      if (existing && url.searchParams.get('overwrite') === '0') return fail(409, 'item_with_same_name_exists', `${nameOf(path)} already exists`);
      await ensureDirs(env, uid, path);
      const id = existing?.id || crypto.randomUUID();
      await env.FILES.put(blobKey(uid, id), body);
      const now = Date.now();
      await DB.prepare('INSERT INTO files (user_id, path, id, is_dir, size, created, modified) VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT(user_id, path) DO UPDATE SET size = excluded.size, modified = excluded.modified')
        .bind(uid, path, id, body.byteLength, now, now).run();
      return json(item(await rowOf(env, uid, { path })));
    }
    case '/fs/rename': {
      const path = cleanPath(url.searchParams.get('path'));
      const { name } = await readJson(request);
      const leaf = String(name ?? '');
      if (!path || !leaf || leaf.includes('/') || !cleanPath(leaf)) return fail(400, 'bad_path', 'Bad name');
      const row = await rowOf(env, uid, { path });
      if (!row) return notFound(path);
      const dest = parentOf(path) ? `${parentOf(path)}/${leaf}` : leaf;
      if (await rowOf(env, uid, { path: dest })) return fail(409, 'item_with_same_name_exists', `${leaf} already exists`);
      await DB.prepare('UPDATE files SET path = ?, modified = ? WHERE user_id = ? AND path = ?').bind(dest, Date.now(), uid, path).run();
      if (row.is_dir) await DB.prepare("UPDATE files SET path = ? || substr(path, ?) WHERE user_id = ? AND path LIKE ? ESCAPE '\\'").bind(dest, path.length + 1, uid, `${escLike(path)}/%`).run();
      return json(item(await rowOf(env, uid, { path: dest })));
    }
    case '/fs/delete': {
      const path = cleanPath(url.searchParams.get('path'));
      if (!path) return fail(400, 'bad_path', 'Bad path');
      const row = await rowOf(env, uid, { path });
      if (!row) return notFound(path);
      const kids = row.is_dir ? (await DB.prepare("SELECT id, is_dir FROM files WHERE user_id = ? AND path LIKE ? ESCAPE '\\'").bind(uid, `${escLike(path)}/%`).all()).results : [];
      if (kids.length && url.searchParams.get('recursive') !== '1') return fail(409, 'not_empty', 'Folder is not empty');
      const blobs = [row, ...kids].filter((r) => !r.is_dir).map((r) => blobKey(uid, r.id));
      for (let i = 0; i < blobs.length; i += 1000) await env.FILES.delete(blobs.slice(i, i + 1000));
      await DB.prepare("DELETE FROM files WHERE user_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')").bind(uid, path, `${escLike(path)}/%`).run();
      return json({ ok: true });
    }
  }
  return fail(404, 'not_found', 'Unknown API route');
}

// ---------------------------------------------------------------- licence + source offer (public)
const PAGE_CSS = 'body{font:15px/1.55 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1d1d1f}code{background:#f2f2f2;padding:1px 5px;border-radius:4px}a{color:#356d49}';
function sourcePage(env) {
  const tag = env.SOURCE_TAG || 'main';
  const ver = env.CF_VERSION_METADATA?.id || 'unknown';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Source code · Spreadsheet (Amplify staging)</title><style>${PAGE_CSS}</style></head><body>
<h1>Source code for this Spreadsheet</h1>
<p>This Spreadsheet is free software, licensed under the <a href="/license">GNU Affero General Public License v3.0 only</a>. It is a <strong>modified version</strong> of the Spreadsheet app by Puter Technologies Inc. (<a href="https://github.com/HeyPuter/everything">HeyPuter/everything</a>, <code>src/spreadsheet</code>). Amplify replaced Puter's cloud with Amplify storage and sign-in.</p>
<p>The complete corresponding source of the version running here, including every Amplify modification and this server, is public:</p>
<ul><li>Repository: <a href="${REPO}">${REPO}</a></li>
<li>Exact version: tag <a href="${esc(sourceUrl(env))}"><code>${esc(tag)}</code></a> (directory <code>apps/spreadsheet</code>)</li>
<li>Download: <a href="${REPO}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz">${esc(tag)}.tar.gz</a></li>
<li>Running Worker version: <code>${esc(ver)}</code></li></ul>
<p>Questions: hello@amplify.is</p></body></html>`;
}

class SourceLink {
  element(el) {
    el.append('<a href="/source" style="position:fixed;right:8px;bottom:6px;z-index:2147483647;font:12px system-ui,sans-serif;color:#356d49;background:rgba(255,255,255,.85);padding:2px 6px;border-radius:6px;text-decoration:none">AGPL source</a>', { html: true });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === '/health') return finish(json({ ok: true, service: 'stg-agpl-spreadsheet', enabled: env.SPREADSHEET_ENABLED === '1', source: env.SOURCE_TAG || null }), env);
    // the AGPL §13 offer is open to every network user, signed in or not
    if (p === '/source' && (request.method === 'GET' || request.method === 'HEAD')) return finish(new Response(sourcePage(env), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }), env, { html: true });
    if (p === '/license' && (request.method === 'GET' || request.method === 'HEAD')) {
      const res = await env.ASSETS.fetch(new Request(new URL('/LICENSE.txt', url)));
      return finish(new Response(res.body, { status: res.status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }), env);
    }
    if (env.SPREADSHEET_ENABLED !== '1') return finish(fail(503, 'disabled', 'Spreadsheet is off (SPREADSHEET_ENABLED flag)'), env);
    if (env.AUTH_MODE !== 'access' || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return finish(fail(503, 'auth_not_configured', 'Staging sign-in is not configured'), env);
    const who = await verifyAccess(request, env).catch(() => null);
    if (!who) return finish(fail(401, 'unauthorized', 'Sign in through Amplify staging (Cloudflare Access)'), env);
    const uid = await userIdOf(who.email);
    try {
      if (p.startsWith('/api/')) return finish(await api(request, env, url, uid, who.email), env);
      const res = await env.ASSETS.fetch(request);
      const isHtml = (res.headers.get('content-type') || '').includes('text/html');
      const out = isHtml ? new HTMLRewriter().on('body', new SourceLink()).transform(res) : res;
      return finish(out, env, { html: isHtml });
    } catch (err) {
      const status = err?.status || 500;
      console.log(JSON.stringify({ level: 'error', route: p, status, message: String(err?.message || err) }));
      return finish(fail(status, status === 500 ? 'server_error' : 'bad_request', status === 500 ? 'Something went wrong' : String(err.message)), env);
    }
  },
};
