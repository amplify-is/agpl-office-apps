/**
 * Amplify storage adapter for the Spreadsheet app (Amplify staging, 2026-11-15).
 *
 * Copyright (c) 2026 Guðmundur Eyberg Kristjánsson (Amplify). A modification of the Spreadsheet app,
 * Copyright (c) 2026 Puter Technologies Inc. Licensed under the GNU Affero General Public License v3.0 only
 * (see ../../LICENSE). Corresponding source: https://github.com/amplify-is/agpl-office-apps
 *
 * Replaces the Puter.js SDK (js.puter.com) with the subset the app reaches through src/lib/puter.js, backed by
 * the app's own isolated Worker (apps/spreadsheet/amplify/worker) on Amplify staging storage:
 *   auth -> the Cloudflare Access identity the Worker verified    kv -> D1    fs -> R2 (+ a D1 index for file ids)
 * Not provided, so the app hides or falls back on its own: AI (puter.ai), sharing and live collaboration
 * (puter.fs.share / puter.workers / puter.peer), email (puter.workers), Puter file pickers (puter.ui), puter.net.
 * Every call is a same-origin POST.
 */
(() => {
  if (typeof window === 'undefined' || window.puter) return;
  const API = '/api';

  class ApiError extends Error {
    constructor(message, code, status) { super(message); this.code = code; this.status = status; }
  }
  async function call(path, { body, query, bytes } = {}) {
    const url = new URL(`${API}${path}`, location.origin);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const init = { method: 'POST', credentials: 'same-origin', headers: {} };
    if (bytes !== undefined) { init.body = bytes; init.headers['content-type'] = 'application/octet-stream'; }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await fetch(url, init);
    if (res.redirected) throw new ApiError('Signed out', 'unauthorized', 401);
    if (!res.ok) {
      let code = 'error'; let message = `Request failed (${res.status})`;
      try { const j = await res.json(); code = j.code || code; message = j.message || message; } catch {}
      throw new ApiError(message, code, res.status);
    }
    return res;
  }
  const json = async (path, opts) => (await call(path, opts)).json();
  const target = (p) => (p && typeof p === 'object' ? { uid: p.uid ?? p.id } : { path: p });

  let me = null;
  const getUser = async () => (me ??= await json('/me'));

  window.puter = {
    env: 'web',
    amplify: true,
    auth: {
      isSignedIn: async () => { try { await getUser(); return true; } catch (e) { if (e.status === 401) return false; throw e; } },
      getUser,
      signIn: async () => { location.reload(); return new Promise(() => {}); },
      signOut: () => { me = null; location.href = '/cdn-cgi/access/logout'; },
    },
    kv: {
      get: async (key) => (await json('/kv/get', { body: { key } })).value ?? null,
      set: async (key, value) => { await json('/kv/set', { body: { key, value } }); return true; },
      del: async (key) => { await json('/kv/del', { body: { key } }); return true; },
    },
    fs: {
      read: async (p) => {
        const res = await call('/fs/read', { query: target(p) });
        return new Blob([await res.arrayBuffer()], { type: res.headers.get('content-type') || 'application/octet-stream' });
      },
      write: async (path, data, opts = {}) => {
        const bytes = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : String(data ?? '')]);
        return json('/fs/write', { query: { path, overwrite: opts.overwrite === false ? 0 : 1, dedupe: opts.dedupeName ? 1 : 0 }, bytes });
      },
      mkdir: async (path) => json('/fs/mkdir', { query: { path } }),
      readdir: async (path) => (await json('/fs/readdir', { query: { path } })).items,
      stat: async (p) => json('/fs/stat', { query: target(p) }),
      rename: async (path, newName) => json('/fs/rename', { query: { path }, body: { name: newName } }),
      delete: async (path, opts) => { await json('/fs/delete', { query: { path, recursive: opts?.recursive ? 1 : 0 } }); },
    },
  };
})();
