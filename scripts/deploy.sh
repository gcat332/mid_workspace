#!/usr/bin/env bash
# Deploy MidHub on a single host (no Docker). Idempotent — safe to re-run.
# Run as root:  sudo scripts/deploy.sh      (APP_DIR=/path APP_USER=bsmmidhub to override)
#
# App steps (git, npm, build) run as APP_USER from APP_DIR, so the checkout, node_modules
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
# The checkout is writable by $APP_USER while root runs install.sh from it: that is the plan's design (same as AgentHub).
as_app() { sudo -u "$APP_USER" -H "$@"; }

# `npm ci` replaces node_modules and `next build` wipes .next while the old process keeps running, so a
# failure after that point leaves a tree that cannot be restarted. AgentHub has no guard for this (its
# build.sh only documents it), so warn loudly and tell the operator what to do.
PREV_SHA="$(as_app git rev-parse HEAD)"
STAGE=pre-install
on_exit() {
  local rc=$?
  trap - EXIT
  if [[ $rc -ne 0 && $STAGE != pre-install ]]; then
    {
      echo
      echo "############################################################"
      echo "# DEPLOY FAILED (exit $rc) during: $STAGE"
      case $STAGE in
        "install.sh" | "restart / health check")
          # install.sh may already have try-restarted the app; the restart stage certainly did.
          if [[ $STAGE == "install.sh" ]]; then
            echo "# install.sh may already have restarted $SERVICE: check with  systemctl is-active $SERVICE"
          else
            echo "# $SERVICE WAS RESTARTED AND IS NOT HEALTHY: MidHub is probably DOWN right now."
          fi
          echo "# See why (e.g. a failed DB migration in ExecStartPre):  journalctl -u $SERVICE -n 100"
          echo "# Fix the cause and re-run scripts/deploy.sh, or roll back to the previous version:"
          echo "#   sudo -u $APP_USER -H git -C $APP_DIR reset --hard $PREV_SHA   then re-run scripts/deploy.sh"
          echo "# (a DB migration that already ran is not undone by the rollback)"
          ;;
        *)
          echo "# The running MidHub process still works, but .next / node_modules may be incomplete."
          echo "# Do NOT restart $SERVICE (or run install.sh) until a deploy succeeds."
          echo "# Fix the cause and re-run scripts/deploy.sh, or roll back:"
          echo "#   sudo -u $APP_USER -H git -C $APP_DIR reset --hard $PREV_SHA   then re-run scripts/deploy.sh"
          ;;
      esac
      echo "############################################################"
    } >&2
  fi
  exit "$rc"
}
trap on_exit EXIT

echo "==> Pull latest"
as_app git pull --ff-only

STAGE="npm ci"
echo "==> Install deps (keeps devDependencies — the build needs them; .npmrc carries legacy-peer-deps)"
as_app npm ci

STAGE="prisma generate"
echo "==> Generate Prisma client (no postinstall hook does it)"
as_app npx prisma generate

STAGE="build"
echo "==> Build (next build + helper build)"
as_app npm run build

# DB migrations are NOT run here: `prisma migrate deploy` needs a lock the running app's SQLite
# connection prevents ("database is locked"). bsm-midhub.service runs it as ExecStartPre on the
# restart below (with the app stopped), and the health check fails the deploy if that fails.
[[ -n "$(sed -n 's/^DATABASE_URL=//p' .env.local)" ]] || { echo "DATABASE_URL is not set in $APP_DIR/.env.local." >&2; exit 1; }

STAGE="install.sh"
echo "==> Install helper copy + units (root-owned helper; restarts the helper itself only if it changed)"
# install.sh prints "midhub-install: changed=0|1" and try-restarts bsm-midhub-helper (and bsm-midhub)
# when the helper copy, a unit file or group membership changed.
APP_USER="$APP_USER" deploy/install.sh "$APP_DIR"

STAGE="restart / health check"
echo "==> Restart service (ExecStartPre applies pending DB migrations)"
systemctl restart "$SERVICE"
systemctl --no-pager status "$SERVICE" | head -5 || true

echo "==> Health check (http://127.0.0.1:${PORT:-3100}/midhub/login, up to 60 s)"
healthy=0
for _ in $(seq 1 30); do
  if [[ "$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:${PORT:-3100}/midhub/login" || true)" == "200" ]]; then healthy=1; break; fi
  sleep 2
done
[[ $healthy -eq 1 ]] || { echo "Health check FAILED: /midhub/login never returned 200 within 60 s. See: journalctl -u $SERVICE -n 100" >&2; exit 1; }

echo "==> Done."
