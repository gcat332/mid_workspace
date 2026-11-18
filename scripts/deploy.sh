#!/usr/bin/env bash
# Deploy MidHub on a single host (no Docker). Idempotent — safe to re-run.
# Run as root:  sudo scripts/deploy.sh      (APP_DIR=/path APP_USER=bsmmidhub to override)
#
# App steps (git, npm, build, migrate) run as APP_USER from APP_DIR, so the checkout, node_modules
# and .next stay owned by the service user. Only deploy/install.sh and the restart need root.
# Runtime state (SQLite DB, MIDs) lives OUTSIDE the repo under /opt/midhub, so `git pull` never
# touches it. DATABASE_URL comes from APP_DIR/.env.local (see deploy/README.md).
# Never touches Caddy or bsm-agenthub.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/bsmmidhub/midhub}"
APP_USER="${APP_USER:-bsmmidhub}"
SERVICE="${SERVICE:-bsm-midhub}"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo scripts/deploy.sh)." >&2; exit 1; }
id "$APP_USER" >/dev/null 2>&1 || { echo "App user '$APP_USER' does not exist." >&2; exit 1; }
[[ -d "$APP_DIR/.git" ]] || { echo "$APP_DIR is not a git checkout." >&2; exit 1; }
[[ -f "$APP_DIR/.env.local" ]] || { echo "Missing $APP_DIR/.env.local - create it first (see deploy/README.md)." >&2; exit 1; }

cd "$APP_DIR"
as_app() { sudo -u "$APP_USER" -H "$@"; }

echo "==> Pull latest"
as_app git pull --ff-only

echo "==> Install deps (keeps devDependencies — the build needs them; .npmrc carries legacy-peer-deps)"
as_app npm ci

echo "==> Generate Prisma client (no postinstall hook does it)"
as_app npx prisma generate

echo "==> Build (next build + helper build)"
as_app npm run build

echo "==> Apply DB migrations"
# prisma.config.ts reads DATABASE_URL from the environment and does not load .env.local itself;
# pass only that one value (the file also holds secrets that migrate has no business seeing).
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.local | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
[[ -n "$DATABASE_URL" ]] || { echo "DATABASE_URL is not set in $APP_DIR/.env.local." >&2; exit 1; }
as_app env DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy

echo "==> Install helper copy + units (root-owned helper; restarts the helper itself only if it changed)"
# install.sh prints "midhub-install: changed=0|1" and try-restarts bsm-midhub-helper (and bsm-midhub)
# when the helper copy, a unit file or group membership changed.
APP_USER="$APP_USER" deploy/install.sh "$APP_DIR"

echo "==> Restart service"
systemctl restart "$SERVICE"
systemctl --no-pager status "$SERVICE" | head -5

echo "==> Done."
