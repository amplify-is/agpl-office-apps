import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto as crypto } from 'node:crypto';
import worker, { cleanPath } from '../worker/index.js';
import { check } from '../scripts/check-prod-config.mjs';

const TEAM = 'amplify-staging.cloudflareaccess.com', AUD = 'c'.repeat(64), ORIGIN = 'https://stg-agpl-spreadsheet.shiny-water-7fa0.workers.dev';
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
globalThis.fetch = async (u) => { if (String(u) === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] })); throw new Error(`fetch ${u}`); };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function jwt(c = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = b64u(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: 'hello@amplify.is', exp: now + 600, ...c }));
  return `${h}.${p}.${b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${h}.${p}`)))}`;
}
// D1 over node:sqlite (real SQL), R2 as a map
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return { prepare: (sql) => ({ bind: (...a) => { const st = db.prepare(sql); return {
    first: async () => st.get(...a) ?? null, run: async () => ({ meta: { changes: Number(st.run(...a).changes) } }), all: async () => ({ results: st.all(...a) }),
  }; } }) };
}
function r2() { const m = new Map(); return { m, put: async (k, b) => { m.set(k, new Uint8Array(b)); }, get: async (k) => (m.has(k) ? { body: m.get(k) } : null), delete: async (k) => { for (const x of [].concat(k)) m.delete(x); } }; }
const mkEnv = (o = {}) => ({ SPREADSHEET_ENABLED: '1', AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: 'hello@amplify.is', SOURCE_TAG: 'spreadsheet-stg-abc1234', CF_VERSION_METADATA: { id: 'v-1' },
  DB: d1(), FILES: r2(), ASSETS: { fetch: async (r) => new Response(new URL(r.url).pathname === '/LICENSE.txt' ? 'GNU AFFERO GENERAL PUBLIC LICENSE' : 'asset') }, ...o });
const T = await jwt();
const call = (env, path, { body, bytes, method = 'POST', token = T, origin = ORIGIN } = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { method,
  headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...(origin ? { origin } : {}), 'content-type': bytes !== undefined ? 'application/octet-stream' : 'application/json' },
  body: method === 'GET' || method === 'HEAD' ? undefined : bytes ?? (body === undefined ? undefined : JSON.stringify(body)) }), env);
const J = async (r) => { const res = await r; return { status: res.status, body: await res.json() }; };

test('fails closed; /source and /license are public and name the exact tag', async () => {
  const env = mkEnv();
  for (const p of ['/', '/api/me']) assert.equal((await call(env, p, { token: null, method: p === '/' ? 'GET' : 'POST' })).status, 401);
  assert.equal((await call(env, '/api/me', { token: await jwt({ email: 'x@y.is' }) })).status, 401);
  assert.equal((await call(env, '/api/me', { token: await jwt({ aud: ['d'.repeat(64)] }) })).status, 401);
  assert.equal((await call({ ...env, SPREADSHEET_ENABLED: '0' }, '/api/me')).status, 503);
  const src = await call({ ...env, SPREADSHEET_ENABLED: '0' }, '/source', { token: null, method: 'GET' });
  assert.equal(src.status, 200); const html = await src.text();
  assert.match(html, /tree\/spreadsheet-stg-abc1234\/apps\/spreadsheet/); assert.match(html, /v-1/); assert.match(html, /modified version/);
  assert.match(src.headers.get('x-source-offer'), /agpl-office-apps\/tree\/spreadsheet-stg-abc1234/);
  const lic = await call(env, '/license', { token: null, method: 'GET' });
  assert.equal(lic.status, 200); assert.match(await lic.text(), /AFFERO/);
});

test('drive semantics the app relies on (src/lib/puter.js)', async () => {
  const env = mkEnv();
  assert.equal((await call(env, '/api/fs/readdir?path=Spreadsheets')).status, 404);
  assert.equal((await J(call(env, '/api/fs/mkdir?path=Spreadsheets'))).body.is_dir, true);
  assert.deepEqual((await J(call(env, '/api/fs/readdir?path=Spreadsheets'))).body.items, []);
  const w = (await J(call(env, '/api/fs/write?path=Spreadsheets/Budget%202026.xlsx&overwrite=1&dedupe=0', { bytes: 'PK-1' }))).body;
  assert.equal(w.name, 'Budget 2026.xlsx'); assert.equal(w.size, 4); assert.ok(w.uid);
  const d = (await J(call(env, '/api/fs/write?path=Spreadsheets/Budget%202026.xlsx&dedupe=1', { bytes: 'PK-2' }))).body;
  assert.equal(d.name, 'Budget 2026 (1).xlsx');
  assert.equal((await J(call(env, '/api/fs/write?path=Spreadsheets/Budget%202026.xlsx&overwrite=0', { bytes: 'x' }))).body.code, 'item_with_same_name_exists');
  await call(env, '/api/fs/write?path=Spreadsheets/Budget%202026.xlsx&overwrite=1', { bytes: 'PK-3!' });
  assert.equal(await (await call(env, '/api/fs/read?path=Spreadsheets/Budget%202026.xlsx')).text(), 'PK-3!');
  assert.equal(await (await call(env, `/api/fs/read?uid=${w.uid}`)).text(), 'PK-3!', 'same id after overwrite');
  await call(env, '/api/fs/write?path=Spreadsheets/.versions/Budget/v1.xlsx', { bytes: 'old' });
  const names = (await J(call(env, '/api/fs/readdir?path=Spreadsheets'))).body.items.map((i) => `${i.name}${i.is_dir ? '/' : ''}`).sort();
  assert.deepEqual(names, ['.versions/', 'Budget 2026 (1).xlsx', 'Budget 2026.xlsx']);
  const r = (await J(call(env, '/api/fs/rename?path=Spreadsheets/Budget%202026.xlsx', { body: { name: 'Plan.xlsx' } }))).body;
  assert.equal(r.path, 'Spreadsheets/Plan.xlsx'); assert.equal(r.uid, w.uid);
  assert.equal((await J(call(env, `/api/fs/stat?uid=${w.uid}`))).body.path, 'Spreadsheets/Plan.xlsx', 'id follows a rename');
  assert.equal((await J(call(env, '/api/fs/stat?path=Nope.xlsx'))).body.code, 'subject_does_not_exist');
  assert.equal((await call(env, '/api/fs/delete?path=Spreadsheets/.versions')).status, 409);
  assert.equal((await call(env, '/api/fs/delete?path=Spreadsheets/.versions&recursive=1')).status, 200);
  assert.equal((await call(env, '/api/fs/stat?path=Spreadsheets/.versions/Budget/v1.xlsx')).status, 404);
  assert.equal(env.FILES.m.size, 2);
  // LIKE wildcards in names stay literal
  await call(env, '/api/fs/write?path=A_b%25/x.xlsx', { bytes: '1' }); await call(env, '/api/fs/write?path=AXbY/y.xlsx', { bytes: '1' });
  assert.deepEqual((await J(call(env, `/api/fs/readdir?path=${encodeURIComponent('A_b%')}`))).body.items.map((i) => i.name), ['x.xlsx']);
});

test('kv, isolation between users, bad paths, CSRF, methods', async () => {
  const env = mkEnv({ ALLOWED_EMAILS: 'hello@amplify.is,other@amplify.is' });
  await call(env, '/api/kv/set', { body: { key: 'spreadsheet:settings:v1', value: '{"theme":"dark"}' } });
  assert.equal((await J(call(env, '/api/kv/get', { body: { key: 'spreadsheet:settings:v1' } }))).body.value, '{"theme":"dark"}');
  await call(env, '/api/fs/write?path=Spreadsheets/Mine.xlsx', { bytes: 'secret' });
  const o = await jwt({ email: 'other@amplify.is' });
  assert.equal((await J(call(env, '/api/kv/get', { body: { key: 'spreadsheet:settings:v1' }, token: o }))).body.value, null);
  assert.equal((await call(env, '/api/fs/read?path=Spreadsheets/Mine.xlsx', { token: o })).status, 404);
  for (const p of ['/etc/passwd', '../x', 'a/../b', '~/Trash/x', 'a//b', 'a\\b', '']) assert.equal(cleanPath(p), null, p);
  assert.equal(cleanPath('Spreadsheets/.versions/Ünïcode 👨‍👩‍👧.xlsx'), 'Spreadsheets/.versions/Ünïcode 👨‍👩‍👧.xlsx');
  assert.equal((await call(env, '/api/me', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(env, '/api/me', { method: 'GET' })).status, 405);
});

test('guard', () => {
  const base = { name: 'stg-agpl-spreadsheet-local', vars: { SPREADSHEET_ENABLED: '0' }, env: { staging: { name: 'stg-agpl-spreadsheet', vars: { SPREADSHEET_ENABLED: '1', AUTH_MODE: 'access', ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, ALLOWED_EMAILS: 'hello@amplify.is' } } } };
  assert.deepEqual(check(base), []);
  assert.ok(check({ ...base, env: { ...base.env, production: { name: 'amplify-sheet' } } }).length);
  assert.ok(check({ ...base, vars: { SPREADSHEET_ENABLED: '1' } }).length);
  assert.ok(check({ ...base, env: { staging: { ...base.env.staging, d1_databases: [{ database_name: 'iventure-db' }] } } }).length);
  assert.ok(check({ ...base, env: { staging: { ...base.env.staging, routes: ['sheet.amplify.is/*'] } } }).length);
  assert.ok(check({ ...base, env: { staging: { ...base.env.staging, vars: { ...base.env.staging.vars, ACCESS_AUD: '' } } } }).length);
});
