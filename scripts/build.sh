#!/usr/bin/env bash
# `npm run build` — `next build` followed by the root-helper build (`npm run helper:build`).
#
# One entry point so CI, deploy.sh and a hand build all produce the same two artifacts:
#   .next/                      the web app (served by bsm-midhub)
#   helper/dist/helper/main.js  the root helper (deploy/install.sh copies it to /usr/local/lib/midhub-helper)
# deploy/install.sh refuses to run unless both exist, so a build that skips the helper half is a bug.
#
# Calls `npx next build` directly (NOT `npm run build`, which would recurse into this script).
# Unlike AgentHub there is no workspace/sessions tree to mask from Turbopack, so no bwrap step.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npx next build "$@"
npm run helper:build
