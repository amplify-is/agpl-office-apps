# Amplify modifications to Spreadsheet

Upstream: HeyPuter/everything `src/spreadsheet` at `71e76b32b90f6222260f1ee643d274103a03e0aa`
(Copyright (c) 2026 Puter Technologies Inc., AGPL-3.0-only). The unmodified snapshot is the first
commit that touches `apps/spreadsheet/` in this repository, so `git diff` from it shows every change.

Modified by Guðmundur Eyberg Kristjánsson (Amplify, hello@amplify.is). All modifications are licensed
AGPL-3.0-only, like the app.

## 2026-11-15 — staging service `stg-agpl-spreadsheet`

- `src/amplify/puter-adapter.js` (new): replaces the Puter.js SDK with Amplify staging storage
  (D1 key/value, files in D1 + R2) behind Cloudflare Access. AI, sharing, live collaboration, email,
  Puter file pickers and `puter.net` are not provided, so the app hides or falls back on them.
- `src/main.js`: imports the adapter before anything else.
- `index.html`: Puter SDK, Plausible analytics and the spreadsheet.puter.com canonical removed; `noindex` added.
- `vite.config.js`: the Puter monorepo dev-host plugin import removed (not part of this tree).
- `public/LICENSE.txt` (new): copy of `LICENSE`, served at `/license`.
- `amplify/` (new): the server that runs this app on Amplify —
  `worker/index.js` (Access re-verification, storage API, public `/source` and `/license`,
  `X-Source-Offer` header and an "AGPL source" link injected into every page), `migrations/`,
  `wrangler.jsonc`, `scripts/check-prod-config.mjs` (staging-only guard; refuses to deploy a commit that
  is not pushed and tagged), `scripts/deploy-staging.sh`, `test/`.

Each deployed version is tagged `spreadsheet-stg-<shortsha>`; the running service's `/source` page names its tag.
