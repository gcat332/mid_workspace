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
HELPER_LIB=/usr/local/lib/midhub-helper

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

# The app user must be able to read the checkout, write .next (Next's cache) and run node/prisma.
as_app() { runuser -u "$APP_USER" -- "$@"; }
precheck_fail() {
  echo "$1" >&2
  echo "Fix: deploy a checkout owned by $APP_USER (e.g. git clone as $APP_USER) or: chown -R $APP_USER:$APP_USER $APP_DIR" >&2
  exit 1
}
as_app test -r "$APP_DIR" -a -x "$APP_DIR" || precheck_fail "$APP_USER cannot read $APP_DIR"
as_app test -w "$APP_DIR/.next" || precheck_fail "$APP_USER cannot write $APP_DIR/.next"
as_app test -x /usr/bin/node || precheck_fail "$APP_USER cannot execute /usr/bin/node"
as_app test -x "$APP_DIR/node_modules/.bin/prisma" || precheck_fail "$APP_USER cannot execute $APP_DIR/node_modules/.bin/prisma"

# Phase 2 install/clone jobs shell out to these (absolute paths, execFile).
for bin in /usr/bin/unzip /usr/bin/zipinfo /usr/bin/tar; do
  [[ -x "$bin" ]] || { echo "Missing $bin - install it first (apt install unzip tar)" >&2; exit 1; }
done

changed=0
getent group midhub >/dev/null || groupadd midhub
id midsvc >/dev/null 2>&1 || useradd -r -g midhub -s /usr/sbin/nologin -d /nonexistent -M midsvc
id -nG "$APP_USER" | tr ' ' '\n' | grep -qx midhub || { usermod -aG midhub "$APP_USER"; changed=1; }

install -d -m 0755 -o root -g root "$ROOT_DIR"
# mids/ is 2770 (no access for others): config.xml carries a plaintext password until the MID first starts
install -d -m 2770 -o midsvc -g midhub "$ROOT_DIR/mids"
chown midsvc:midhub "$ROOT_DIR/mids"; chmod 2770 "$ROOT_DIR/mids"
install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$ROOT_DIR/staging"  # private extraction area, same fs as mids
chown "$APP_USER:$APP_USER" "$ROOT_DIR/staging"; chmod 0700 "$ROOT_DIR/staging"
for d in packages archive db jobs; do
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$ROOT_DIR/$d"
  chown "$APP_USER:$APP_USER" "$ROOT_DIR/$d"; chmod 0750 "$ROOT_DIR/$d"
done

# The root helper must never execute files the app user can modify (C1): copy the build into a
# root-owned directory (dirs 0755, files 0644, root:root) and run it from there. Only regular
# files/dirs are accepted (a symlink in the build could point back into app-writable space).
install_helper() {
  local src="$APP_DIR/helper/dist" tmp bad
  bad="$(find "$src" ! -type f ! -type d -print -quit)"
  [[ -z "$bad" ]] || { echo "Refusing: $src contains a non-regular file ($bad)" >&2; exit 1; }
  install -d -m 0755 -o root -g root "$(dirname "$HELPER_LIB")"
  tmp="$(mktemp -d "$(dirname "$HELPER_LIB")/.midhub-helper.XXXXXX")"
  ( cd "$src" && find . -type d -print0 ) | while IFS= read -r -d '' d; do
    install -d -m 0755 -o root -g root "$tmp/$d"
  done
  ( cd "$src" && find . -type f -name '*.js' -print0 ) | while IFS= read -r -d '' f; do
    install -m 0644 -o root -g root "$src/$f" "$tmp/$f"
  done
  chmod 0755 "$tmp"; chown root:root "$tmp"
  [[ -f "$tmp/helper/main.js" ]] || { rm -rf "$tmp"; echo "Helper copy is missing helper/main.js" >&2; exit 1; }
  if [[ -d "$HELPER_LIB" ]] && diff -rq "$tmp" "$HELPER_LIB" >/dev/null 2>&1; then
    rm -rf "$tmp"
    return
  fi
  rm -rf "$HELPER_LIB.old"
  [[ -e "$HELPER_LIB" ]] && mv "$HELPER_LIB" "$HELPER_LIB.old"
  mv "$tmp" "$HELPER_LIB"
  rm -rf "$HELPER_LIB.old"
  changed=1
}
install_helper

for unit in bsm-midhub.service bsm-midhub-helper.service; do
  tmp="$(mktemp)"
  sed "s|@APP_DIR@|$APP_DIR|g" "$SCRIPT_DIR/$unit" > "$tmp"
  cmp -s "$tmp" "/etc/systemd/system/$unit" || changed=1
  install -m 0644 "$tmp" "/etc/systemd/system/$unit"; rm -f "$tmp"
done
systemctl daemon-reload
systemctl enable --now bsm-midhub-helper.service bsm-midhub.service
if [[ $changed -eq 1 ]]; then
  # Units/groups changed: pick them up on already-running services (no-op if not running).
  # Restarting the helper recreates the socket inode; the app reconnects per request, so this
  # is safe. Running MIDs are separate units and are unaffected.
  systemctl try-restart bsm-midhub-helper.service bsm-midhub.service
fi

cat <<MSG

Installed. Units rendered with APP_DIR=$APP_DIR; helper copied to $HELPER_LIB (root-owned).

Caddy (NOT modified by this script): paste deploy/Caddyfile.midhub into the AgentHub site
block(s) in /etc/caddy/Caddyfile before the catch-all, then:
  caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
MSG
