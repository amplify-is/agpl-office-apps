#!/bin/sh
# Deploy stg-agpl-spreadsheet to staging ONLY after its exact source is public:
# HEAD must be pushed to origin/main and tagged spreadsheet-stg-<shortsha> on origin. AGPL-3.0-only.
set -eu
cd "$(dirname "$0")/.."
TAG="spreadsheet-stg-$(git rev-parse --short=7 HEAD)"
node scripts/check-prod-config.mjs --deploy "$TAG"
npx wrangler d1 migrations apply stg-agpl-spreadsheet --env staging --remote
npx wrangler deploy --env staging --var "SOURCE_TAG:$TAG"
