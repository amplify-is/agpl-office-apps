#!/usr/bin/env node
/**
 * Prod guard for stg-agpl-spreadsheet (staging only). Runs as the wrangler build. Copyright (c) 2026 Amplify; AGPL-3.0-only.
 *  - no env.production, no env other than staging, no routes / custom domains; names start with "stg-"
 *  - never binds Amplify prod (amplify-db) or the shared staging core (iventure-db, iventure-files), KV, services or mail
 *  - SPREADSHEET_ENABLED "0" at the top level, "1" only in env.staging, and then only with Access settings
 *  - with --deploy <tag>: the tag must exist on the public repo's origin and point at HEAD, and the tree must be clean,
 *    so nothing is deployed whose exact source is not already published
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_D1 = ['amplify-db', '5129a247-8ca9-4545-be41-b00048dfbcae', 'iventure-db', '5cf05e2b-884a-4f6a-af94-86fbe8ab3a55', '21af9367-501b-462f-8dc2-979247476da7', 'iventure-db-staging'];
const FORBIDDEN_R2 = ['iventure-files', 'amplify-images-preview', 'amplify-files', 'stg-office-invoicing'];
export const parseJsonc = (t) => JSON.parse(t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? '').replace(/,(\s*[}\]])/g, '$1'));

export function check(cfg) {
  const errs = [];
  if (cfg.env?.production) errs.push('env.production is refused (staging only; prod needs his separate yes)');
  for (const k of Object.keys(cfg.env ?? {})) if (k !== 'staging') errs.push(`env.${k} is not allowed`);
  for (const [label, e] of [['top-level', cfg], ...Object.entries(cfg.env ?? {})]) {
    const name = e.name ?? cfg.name;
    if (!/^stg-/.test(name)) errs.push(`${label}: worker name must start with "stg-"`);
    if ((e.routes ?? []).length || e.route) errs.push(`${label}: routes / custom domains are refused`);
    for (const d of e.d1_databases ?? []) if (FORBIDDEN_D1.includes(d.database_name) || FORBIDDEN_D1.includes(d.database_id)) errs.push(`${label}: D1 ${d.database_name} is refused`);
    for (const b of e.r2_buckets ?? []) if (FORBIDDEN_R2.includes(b.bucket_name)) errs.push(`${label}: R2 ${b.bucket_name} is refused`);
    if ((e.kv_namespaces ?? []).length || (e.services ?? []).length || e.send_email) errs.push(`${label}: KV, service and mail bindings are refused (isolated service)`);
    const v = e.vars ?? {};
    if (label === 'top-level' && v.SPREADSHEET_ENABLED !== '0') errs.push('top-level: SPREADSHEET_ENABLED must default to "0"');
    if (v.SPREADSHEET_ENABLED === '1') {
      if (label !== 'staging' || name !== 'stg-agpl-spreadsheet') errs.push(`${label}: SPREADSHEET_ENABLED "1" only in env.staging of stg-agpl-spreadsheet`);
      if (v.AUTH_MODE !== 'access' || !/^[a-f0-9]{64}$/.test(v.ACCESS_AUD ?? '') || !/\.cloudflareaccess\.com$/.test(v.ACCESS_TEAM_DOMAIN ?? '') || !(v.ALLOWED_EMAILS ?? '').includes('@'))
        errs.push(`${label}: SPREADSHEET_ENABLED "1" needs AUTH_MODE "access", ACCESS_AUD, ACCESS_TEAM_DOMAIN and ALLOWED_EMAILS`);
    }
  }
  return errs;
}

export function checkPublished(tag) {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const errs = [];
  if (!/^spreadsheet-stg-[0-9a-f]{7,12}$/.test(tag || '')) return ['SOURCE_TAG must look like spreadsheet-stg-<shortsha>'];
  if (git('status', '--porcelain', '--', '..')) errs.push('apps/spreadsheet has uncommitted changes: commit and push the exact source first');
  const head = git('rev-parse', 'HEAD');
  const remote = git('ls-remote', 'origin', `refs/tags/${tag}^{}`, `refs/tags/${tag}`).split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
  if (!remote.includes(head)) errs.push(`tag ${tag} is not on origin at HEAD ${head.slice(0, 7)}: push it first`);
  const onMain = git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  if (onMain !== head) errs.push('origin/main is not at HEAD: push main first');
  return errs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errs = check(parseJsonc(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')));
  const i = process.argv.indexOf('--deploy');
  if (i > 0) errs.push(...checkPublished(process.argv[i + 1]));
  if (errs.length) { console.error(`PROD GUARD FAILED (${errs.length}):`); for (const e of errs) console.error(`  - ${e}`); process.exit(1); }
  console.log(`prod guard ok: stg-agpl-spreadsheet (staging only, flag default off, Access required${i > 0 ? `, source ${process.argv[i + 1]} published` : ''})`);
}
