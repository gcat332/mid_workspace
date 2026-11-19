#!/usr/bin/env bash
# Go-live gate checks for BSM MidHub on a single Ubuntu host (same host as BSM AgentHub).
#
# Runs the AUTOMATABLE gates and prints PASS / FAIL / MANUAL for each.
# Non-destructive: read-only (GET requests, stat, a read-only SQLite open). Never prints secret values.
#
# Usage:
#   sudo ./deploy/golive-gates.sh
#   sudo APP_DIR=/home/bsmmidhub/midhub APP_USER=bsmmidhub PORT=3100 ./deploy/golive-gates.sh
#
# Exit code: 0 if no FAIL, 1 if any gate FAILED. MANUAL items never fail the run
# (they must be verified by hand — see deploy/README.md).

set -uo pipefail

APP_DIR="${APP_DIR:-/home/bsmmidhub/midhub}"
APP_USER="${APP_USER:-bsmmidhub}"
SERVICE="${SERVICE:-bsm-midhub}"
HELPER_SERVICE="${HELPER_SERVICE:-bsm-midhub-helper}"
PORT="${PORT:-3100}"
SOCKET="${SOCKET:-/run/midhub/helper.sock}"
HELPER_LIB="${HELPER_LIB:-/usr/local/lib/midhub-helper}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.local}"
# Caddy sites (from /etc/caddy/Caddyfile): internal-CA HTTPS by IP, and plain HTTP by name. Real browser traffic
# for the domain does NOT use Caddy: the corporate F5 terminates TLS and sends it straight to AgentHub (:3000), whose
# /midhub proxy route (app/midhub/[[...path]]/route.ts) forwards it to MidHub (Gate 14). The Caddy name site is still checked because it still exists.
HTTPS_SITE="${HTTPS_SITE:-https://10.4.150.142}"
HTTP_HOST="${HTTP_HOST:-dev-agenthub.mfec.co.th}"
# Domain path: Host the F5 sends to AgentHub, and AgentHub's port on this host.
DOMAIN_HOST="${DOMAIN_HOST:-dev-agenthub.mfec.co.th}"
AH_PORT="${AH_PORT:-3000}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

pass=0; fail=0; manual=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
no()  { echo "  [FAIL] $1"; fail=$((fail+1)); }
man() { echo "  [MANUAL] $1"; manual=$((manual+1)); }
hdr() { echo; echo "── $1"; }

# Run a command as the service user (the script itself requires root).
as_app() { runuser -u "$APP_USER" -- "$@"; }
# HTTP status code only ("000" when unreachable). Extra args go to curl.
code() { curl -s -o /dev/null --max-time 10 -w '%{http_code}' "$@" 2>/dev/null || true; }
# Value of KEY in .env.local like systemd's EnvironmentFile: last wins, CR stripped, one pair of
# surrounding quotes removed. Callers must never echo it.
envval() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tr -d '\r' | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
# HTTPS site probes: source address 127.0.0.1 (destination stays the site's own IP, so Caddy still picks
# the IP vhost). Caddy then sees a loopback client, which AgentHub's IP allowlist always admits; from the
# host's own LAN address it answers 403. (--connect-to 127.0.0.1 fails: the IP-site cert has no match there.)
HTTPS_ARGS=(-k --interface 127.0.0.1)   # -k ONLY for the internal-CA IP site

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo ./deploy/golive-gates.sh (the 0600 .env.local, the helper socket and the service-user checks need it)." >&2; exit 1; }

echo "BSM MidHub — go-live gate checks"
echo "APP_DIR=$APP_DIR  APP_USER=$APP_USER  SERVICE=$SERVICE  PORT=$PORT"

# ── Gate 1: services active ───────────────────────────────────────────────────
hdr "Gate 1 — services active"
for s in "$SERVICE" "$HELPER_SERVICE"; do
  st=$(systemctl is-active "$s" 2>/dev/null)
  [ "$st" = "active" ] && ok "$s active" || no "$s is '${st:-unknown}'. Fix: sudo systemctl status $s; journalctl -u $s -n 50"
done

# ── Gate 2: helper socket root:bsmmidhub 0660 ─────────────────────────────────
hdr "Gate 2 — helper socket $SOCKET is root:$APP_USER 0660"
if [ -S "$SOCKET" ]; then
  sk=$(stat -c '%U:%G %a' "$SOCKET")
  [ "$sk" = "root:$APP_USER 660" ] && ok "socket $sk" || no "socket is '$sk' (expected 'root:$APP_USER 660')"
else
  no "$SOCKET missing or not a socket — is $HELPER_SERVICE running?"
fi

# ── Gate 3: helper code dir root-owned, not group/world writable ──────────────
hdr "Gate 3 — helper code $HELPER_LIB is root-owned and not group/world-writable"
if [ -d "$HELPER_LIB" ]; then
  bad=$(find "$HELPER_LIB" \( ! -user root -o ! -group root -o -perm /022 \) -print -quit 2>/dev/null)
  if [ -z "$bad" ]; then ok "every entry root:root, no g/o write"; else no "offending entry: $bad. Fix: sudo deploy/install.sh"; fi
else
  no "$HELPER_LIB missing. Fix: sudo deploy/install.sh"
fi

# ── Gate 3b: helper keeps CAP_SETUID/CAP_SETGID (fixOwnership drops to midsvc via setpriv) ─
hdr "Gate 3b — $HELPER_SERVICE has CAP_SETUID and CAP_SETGID"
hpid=$(systemctl show -p MainPID --value "$HELPER_SERVICE" 2>/dev/null)
capeff=$(sed -n 's/^CapEff:[[:space:]]*//p' "/proc/${hpid:-0}/status" 2>/dev/null)
if [ -n "$capeff" ] && [ "${hpid:-0}" != "0" ]; then
  # CAP_SETGID = bit 6, CAP_SETUID = bit 7
  if (( (16#$capeff & 0xC0) == 0xC0 )); then ok "CapEff $capeff includes SETUID+SETGID"
  else no "CapEff $capeff lacks SETUID/SETGID — every install fails at fixOwnership. Fix: no explicit User=root in $HELPER_SERVICE.service (see the unit comment), then sudo deploy/install.sh"; fi
else
  no "cannot read $HELPER_SERVICE capabilities (MainPID '${hpid:-}')"
fi

# ── Gate 3c: the helper unit runs the root-owned copy (not code from the app-writable checkout) ─
hdr "Gate 3c — $HELPER_SERVICE ExecStart is $NODE_BIN $HELPER_LIB/helper/main.js"
# install.sh copies the unit from the app-owned checkout, so whoever can write the checkout could point ExecStart
# back at app-writable code; gate 3 alone would still pass. `systemctl show -p ExecStart` prints:
#   ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /usr/local/lib/midhub-helper/helper/main.js ; ignore_errors=no ; ... }
# Prints the reason and returns 1 unless there is exactly one command and it is exactly the expected one.
helper_exec_check() {
  local out="$1" n path argv want="$NODE_BIN $HELPER_LIB/helper/main.js"
  n=$(grep -o '{ path=' <<<"$out" | wc -l)
  [ "$n" = "1" ] || { echo "expected exactly one ExecStart command, found $n"; return 1; }
  path=$(sed -n 's/^ExecStart={ path=\([^ ;]*\) ; .*/\1/p' <<<"$out")
  argv=$(sed -n 's/.* ; argv\[\]=\(.*\) ; ignore_errors=.*/\1/p' <<<"$out")
  if [ "$path" = "$NODE_BIN" ] && [ "$argv" = "$want" ]; then return 0; fi
  echo "path='$path' argv='$argv'"
  return 1
}
if why=$(helper_exec_check "$(systemctl show -p ExecStart "$HELPER_SERVICE" 2>/dev/null)"); then
  ok "ExecStart runs $HELPER_LIB/helper/main.js"
else
  no "ExecStart is not the root-owned copy ($why). Fix: restore ExecStart=$NODE_BIN $HELPER_LIB/helper/main.js in deploy/$HELPER_SERVICE.service, check the checkout for tampering, then sudo deploy/install.sh"
fi

# ── Gate 4: fs.protected_hardlinks ────────────────────────────────────────────
hdr "Gate 4 — fs.protected_hardlinks=1 (helper chown -R over MID trees depends on it)"
ph=$(sysctl -n fs.protected_hardlinks 2>/dev/null)
[ "$ph" = "1" ] && ok "fs.protected_hardlinks=1" || no "fs.protected_hardlinks=${ph:-unknown}. Fix: sysctl -w fs.protected_hardlinks=1 and persist in /etc/sysctl.d/"

# ── Gate 5: SQLite WAL on the production DB ───────────────────────────────────
hdr "Gate 5 — SQLite WAL mode (prod DB)"
dburl=$(envval DATABASE_URL)
db="${dburl#file:}"
if [ -n "$dburl" ] && [ "${db:0:1}" = "/" ] && [ -f "$db" ]; then
  # Opened read-only as the service user, so no -wal/-shm file is created or re-owned by this check.
  jm=$(cd "$APP_DIR" && as_app "$NODE_BIN" -e "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});console.log(d.pragma('journal_mode',{simple:true}))" "$db" 2>/dev/null)
  [ "$jm" = "wal" ] && ok "journal_mode=wal ($db)" || no "journal_mode=${jm:-unreadable} (expected wal) for $db"
else
  no "DATABASE_URL in $ENV_FILE is unset, not an absolute file: path, or the DB file does not exist. Expected file:/opt/midhub/db/midhub.db"
fi

# ── Gate 6: native module ABI under the service Node ──────────────────────────
hdr "Gate 6 — better-sqlite3 loads under the service Node ($NODE_BIN)"
if [ -d "$APP_DIR/node_modules" ] && [ -x "$NODE_BIN" ]; then
  if (cd "$APP_DIR" && as_app "$NODE_BIN" -e "require('better-sqlite3')" 2>/dev/null); then
    ok "better-sqlite3 loads under $("$NODE_BIN" -v)"
  else
    no "better-sqlite3 load FAILED under $("$NODE_BIN" -v) — ABI mismatch. Fix: (cd $APP_DIR && npm ci)"
  fi
else
  man "$NODE_BIN or $APP_DIR/node_modules not found — verify the Node version matches the build"
fi

# ── Gate 6b: app listens on loopback only (never directly on the LAN) ──────────
hdr "Gate 6b — $SERVICE listens on 127.0.0.1:$PORT only"
listen=$(ss -Hltn "sport = :$PORT" 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' ')
if [ -z "$listen" ]; then no "nothing listens on :$PORT"
elif echo "$listen" | grep -qvE '^(127\.0\.0\.1|\[::1\]|\[::ffff:127\.0\.0\.1\]):'"$PORT"' ?$' && [ "$(echo $listen | tr ' ' '\n' | grep -cvE '^(127\.0\.0\.1|\[::1\]):')" != "0" ]; then
  no "listens on: $listen — reachable from the LAN, bypassing Caddy. Fix: ExecStart … next start -H 127.0.0.1 -p $PORT, then sudo deploy/install.sh"
else ok "listens on: $listen"; fi

# ── Gate 7: app answers on loopback ───────────────────────────────────────────
hdr "Gate 7 — app answers on loopback"
c=$(code "http://127.0.0.1:$PORT/midhub/login")
[ "$c" = "200" ] && ok "http://127.0.0.1:$PORT/midhub/login → 200" || no "/midhub/login → $c (expected 200). Fix: journalctl -u $SERVICE -n 50"

# ── Gate 8: via Caddy, both Caddy sites ───────────────────────────────────────
hdr "Gate 8 — via Caddy on both Caddy sites (/midhub, /midhub/login = 200; /midhub/api/agent/mids = 404)"
# Final status AND final URL after following redirects (signed out: /midhub → /midhub/api/auth/agenthub →
# /midhub/login?reason=signed_out). A site whose
# MidHub handler is missing falls through to AgentHub (307 → /login = 200), so the final path must still
# be under /midhub. The HTTP site is resolved to loopback so the check does not depend on DNS here.
check_site() { # label, then curl base args (-k / --resolve), then base URL last
  local label="$1"; shift
  local base="${!#}" args=("${@:1:$#-1}") out fc fu
  for p in /midhub /midhub/login; do
    out=$(curl -s -o /dev/null --max-time 10 -L --max-redirs 3 -w '%{http_code} %{url_effective}' "${args[@]}" "$base$p" 2>/dev/null || true)
    fc="${out%% *}"; fu="${out#* }"
    case "$fu" in
      "$base"/midhub|"$base"/midhub/*|"$base"/midhub\?*) [ "$fc" = "200" ] && ok "$label $p → 200 (final $fu)" || no "$label $p → $fc (final $fu; expected 200)" ;;
      *) no "$label $p → $fc, final URL '$fu' is outside /midhub (MidHub not served on this site; AgentHub fall-through?)" ;;
    esac
  done
  for p in /midhub/api/agent/mids /midhub/api/%61gent/mids; do
    c=$(code "${args[@]}" "$base$p")
    [ "$c" = "404" ] && ok "$label $p → 404 (AgentHub API not exposed)" || no "$label $p → $c (expected 404). Fix: @midhubAgent block missing in this Caddy site (deploy/Caddyfile.midhub)"
  done
}
check_site "$HTTPS_SITE" "${HTTPS_ARGS[@]}" "$HTTPS_SITE"
check_site "http://$HTTP_HOST" --resolve "$HTTP_HOST:80:127.0.0.1" "http://$HTTP_HOST"

# ── Gate 9: AgentHub still answers ────────────────────────────────────────────
hdr "Gate 9 — AgentHub unaffected (/ = 200 or 307)"
for spec in "$HTTPS_SITE|${HTTPS_ARGS[*]}" "http://$HTTP_HOST|--resolve $HTTP_HOST:80:127.0.0.1"; do
  base="${spec%%|*}"; read -r -a a <<< "${spec#*|}"
  c=$(code "${a[@]}" "$base/")
  case "$c" in 200|307) ok "$base/ → $c" ;; *) no "$base/ → $c (expected 200 or 307). AgentHub broken — check Caddy and bsm-agenthub" ;; esac
done

# ── Gate 10: agent API cannot be reached without the secret ───────────────────
hdr "Gate 10 — direct loopback agent API without the secret is refused"
c=$(code -H 'X-Forwarded-For: 1.2.3.4' "http://127.0.0.1:$PORT/midhub/api/agent/mids")
case "$c" in
  401|404) ok "no secret + spoofed XFF → $c" ;;
  403)     ok "no secret + spoofed XFF → 403 (refused)" ;;
  *)       no "no secret + spoofed XFF → $c (must be 401, 403 or 404, never 200)" ;;
esac

# ── Gate 11: MIDHUB_AGENT_SECRET absent or strong (value never printed) ───────
hdr "Gate 11 — MIDHUB_AGENT_SECRET in .env.local"
if [ -f "$ENV_FILE" ]; then
  sec=$(envval MIDHUB_AGENT_SECRET)
  if [ -z "$sec" ]; then
    man "MIDHUB_AGENT_SECRET not set — AgentHub integration is OFF (API answers 404). Enable per deploy/README.md §9 if wanted"
  elif [ "${#sec}" -ge 32 ]; then
    ok "MIDHUB_AGENT_SECRET set, ${#sec} chars (>= 32)"
  else
    no "MIDHUB_AGENT_SECRET is only ${#sec} chars (needs >= 32). Fix: openssl rand -base64 48"
  fi
  sec=""
else
  no "$ENV_FILE missing"
fi

# ── Gate 12: .env.local mode 0600 ─────────────────────────────────────────────
hdr "Gate 12 — .env.local owned by $APP_USER, mode 0600"
if [ -f "$ENV_FILE" ]; then
  m=$(stat -c '%U %a' "$ENV_FILE")
  [ "$m" = "$APP_USER 600" ] && ok ".env.local $m" || no ".env.local is '$m' (expected '$APP_USER 600'). Fix: chown $APP_USER:$APP_USER $ENV_FILE; chmod 600 $ENV_FILE"
else
  no "$ENV_FILE missing"
fi

# ── Gate 13: AgentHub's listener is owned by AGENTHUB_SERVICE_USER ──────────────
# MidHub refuses to send the AgentHub cookie unless every listener on AgentHub's port belongs to this account
# (lib/auth/listener-owner.ts). Same data the app reads: LISTEN (0A) rows of /proc/net/tcp{,6} on the port.
ah_user=$(envval AGENTHUB_SERVICE_USER); ah_user="${ah_user:-bsmagenthub}"
hdr "Gate 13 — :$AH_PORT listener uid = $ah_user (AGENTHUB_SERVICE_USER)"
if [ "$ah_user" = "none" ]; then
  no "AGENTHUB_SERVICE_USER=none disables the listener-owner check (dev only). Fix: remove it or set the AgentHub account (bsmagenthub)"
elif ! ah_uid=$(id -u "$ah_user" 2>/dev/null); then
  no "user '$ah_user' does not exist (every sign-in would fail with a 500). Fix: AGENTHUB_SERVICE_USER in $ENV_FILE"
else
  ah_hex=$(printf '%04X' "$AH_PORT")
  uids=$(awk -v p=":$ah_hex" '$4 == "0A" && toupper(substr($2, length($2) - 4)) == p { print $8 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u | tr '\n' ' ')
  if [ -z "$uids" ]; then no "nothing listens on :$AH_PORT (AgentHub down?) — MidHub sign-in answers 'AgentHub unreachable'"
  elif [ "$uids" = "$ah_uid " ]; then ok "every :$AH_PORT listener is uid $ah_uid ($ah_user)"
  else no "listeners on :$AH_PORT have uid(s) $uids— expected only $ah_uid ($ah_user). Someone else holds AgentHub's port: check ss -ltnpe 'sport = :$AH_PORT'"
  fi
fi

# ── Gate 14: domain path through AgentHub's /midhub proxy ─────────────────────
# F5 (TLS) -> AgentHub's Next on :$AH_PORT -> its hand-written /midhub route (passes the browser Host through, refuses
# api/agent on decoded segments, strips x-midhub-*) -> 127.0.0.1:$PORT. Probed straight at AgentHub with the Host the
# F5 sends (no F5 or DNS needed). /midhub/login must be 200 (MidHub's access page, not AgentHub's), and every
# spelling of the agent API must be REFUSED: 404 (AgentHub's refusal), or 401/403 (reached MidHub, which has no agent
# route there / no session). Any 2xx fails. --path-as-is keeps curl from normalising the variants. A redirect counts
# by its final status: Next answers 308 for a doubled slash (//midhub/..., /midhub//...) pointing at the clean path.
hdr "Gate 14 — domain path via AgentHub's /midhub proxy (Host: $DOMAIN_HOST -> 127.0.0.1:$AH_PORT)"
AH_BASE="http://127.0.0.1:$AH_PORT"
dom_code() { curl -s -o /dev/null --path-as-is --max-time 10 -w '%{http_code}' -H "Host: $DOMAIN_HOST" "$AH_BASE$1" 2>/dev/null || true; }
dom_final() { curl -s -o /dev/null --path-as-is --max-time 10 -L --max-redirs 3 -w '%{http_code} %{url_effective}' -H "Host: $DOMAIN_HOST" "$AH_BASE$1" 2>/dev/null || true; }
login_c=$(dom_code /midhub/login)
agent_bad=0; agent_all404=1; agent_lines=()
for p in /midhub/api/agent /midhub/api/agent/mids /midhub/api/%61gent/mids /midhub/api/Agent/mids \
         //midhub/api/agent/mids /midhub//api/agent/mids /midhub/api/agent%2Fmids; do
  c=$(dom_code "$p")
  case "$c" in
    301|302|303|307|308)
      f=$(dom_final "$p"); c="${f%% *}"; via=" (after redirect to ${f#* })" ;;
    *) via="" ;;
  esac
  case "$c" in
    404) agent_lines+=("PASS|$p → 404$via") ;;
    401|403) agent_all404=0; agent_lines+=("PASS|$p → $c$via — reached MidHub but refused (no agent route / no session)") ;;
    *) agent_all404=0; agent_bad=1
       agent_lines+=("FAIL|$p → $c$via (expected 404, 401 or 403; a 2xx would mean the agent API is open). Fix (AgentHub): its refusal of api/agent must cover this spelling") ;;
  esac
done
if [ "$login_c" = "404" ] && [ "$agent_bad" = "0" ] && [ "$agent_all404" = "1" ]; then
  man "AgentHub's /midhub proxy not deployed yet: $DOMAIN_HOST/midhub/login via :$AH_PORT → 404 and every agent variant → 404. Re-run after AgentHub ships it"
else
  case "$login_c" in
    200) ok "$DOMAIN_HOST/midhub/login via :$AH_PORT → 200 (proxy reaches MidHub)" ;;
    404) no "$DOMAIN_HOST/midhub/login via :$AH_PORT → 404 (proxy missing) while an agent variant is not 404 (below)" ;;
    *)   no "$DOMAIN_HOST/midhub/login via :$AH_PORT → $login_c (expected 200). AgentHub's proxy.ts must not run on /midhub; its route must target 127.0.0.1:$PORT/midhub" ;;
  esac
  for l in "${agent_lines[@]}"; do
    if [ "${l%%|*}" = "PASS" ]; then ok "$DOMAIN_HOST ${l#*|}"; else no "$DOMAIN_HOST ${l#*|}"; fi
  done
fi

# ── Manual gates ──────────────────────────────────────────────────────────────
hdr "Manual gates"
man "an AgentHub admin can open /midhub: sign in to AgentHub (/login) as an admin, open /midhub on https://10.4.150.142 and https://$DOMAIN_HOST (no second login), and save something there (a POST: CSRF check behind the proxy); a non-admin AgentHub account gets 'ไม่ใช่ admin ของ AgentHub'"
man "SSE through the domain: on https://$DOMAIN_HOST/midhub a MID's Log tab streams lines as they arrive and stays open past 2 minutes (AgentHub proxyTimeout >= 120 s; MidHub pings every 15 s)"
man "F5 X-Forwarded-For: from outside, send 'X-Forwarded-For: 127.0.0.1' through https://$DOMAIN_HOST/midhub with a non-empty MidHub IP allowlist; it must be blocked. If it isn't, the F5 appends instead of replacing; ask network to make it overwrite"
man "validate the spike MID in the instance: import/start the spike MID, confirm it shows Up and validated in the ServiceNow instance"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════"
echo "  PASS: $pass    FAIL: $fail    MANUAL: $manual"
echo "════════════════════════════════════════════════"
if [ "$fail" -gt 0 ]; then
  echo "  NOT READY — resolve the FAILs above before go-live."
  exit 1
fi
echo "  Automated gates passed. Complete the $manual MANUAL checks (see deploy/README.md), then ship."
exit 0
