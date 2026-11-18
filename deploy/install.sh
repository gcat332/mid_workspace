#!/usr/bin/env bash
# MidHub installer. Idempotent. Run as root:  sudo deploy/install.sh [APP_DIR]
# APP_DIR defaults to the repo root this script lives in (override via arg or env).
# Never touches bsm-agenthub or Caddy; Caddy instructions are printed at the end.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-${APP_DIR:-$(dirname "$SCRIPT_DIR")}}"
APP_DIR="$(cd "$APP_DIR" && pwd)"
APP_USER="${APP_USER:-bsmmidhub}"
ROOT_DIR=/opt/midhub

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
case "$APP_DIR" in *[!A-Za-z0-9/._-]*) echo "APP_DIR contains unsupported characters: $APP_DIR" >&2; exit 1;; esac

id "$APP_USER" >/dev/null 2>&1 || { echo "App user '$APP_USER' does not exist; create it first." >&2; exit 1; }

# The helper's `chown -R` over MID trees is only safe when hardlinks are protected.
if [[ "$(sysctl -n fs.protected_hardlinks)" != "1" ]]; then
  echo "fs.protected_hardlinks is not 1. Refusing to install: set it with" >&2
  echo "  sysctl -w fs.protected_hardlinks=1  (and persist in /etc/sysctl.d/)" >&2
  exit 1
fi

# Build artifacts must exist.
[[ -f "$APP_DIR/helper/dist/helper/main.js" ]] || { echo "Missing $APP_DIR/helper/dist/helper/main.js - run: npm run helper:build" >&2; exit 1; }
[[ -d "$APP_DIR/.next" ]] || { echo "Missing $APP_DIR/.next - run: npm run build" >&2; exit 1; }
[[ -f "$APP_DIR/.env.local" ]] || { echo "Missing $APP_DIR/.env.local - create it first (see deploy/README.md)" >&2; exit 1; }

getent group midhub >/dev/null || groupadd midhub
id midsvc >/dev/null 2>&1 || useradd -r -g midhub -s /usr/sbin/nologin -d /nonexistent -M midsvc
id -nG "$APP_USER" | tr ' ' '\n' | grep -qx midhub || usermod -aG midhub "$APP_USER"

install -d -m 0755 -o root -g root "$ROOT_DIR"
install -d -m 2775 -o midsvc -g midhub "$ROOT_DIR/mids"
chown midsvc:midhub "$ROOT_DIR/mids"; chmod 2775 "$ROOT_DIR/mids"
for d in packages archive; do
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$ROOT_DIR/$d"
  chown "$APP_USER:$APP_USER" "$ROOT_DIR/$d"; chmod 0750 "$ROOT_DIR/$d"
done

for unit in bsm-midhub.service bsm-midhub-helper.service; do
  sed "s|@APP_DIR@|$APP_DIR|g" "$SCRIPT_DIR/$unit" > "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now bsm-midhub-helper.service bsm-midhub.service

cat <<MSG

Installed. Units rendered with APP_DIR=$APP_DIR.
NOTE: if $APP_USER was just added to group midhub, restart bsm-midhub so the group applies.

Caddy (NOT modified by this script): paste deploy/Caddyfile.midhub into the AgentHub site
block(s) in /etc/caddy/Caddyfile before the catch-all, then:
  caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
MSG
