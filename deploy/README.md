# MidHub deployment runbook

Layout on the host: web app `bsm-midhub.service` (user `bsmmidhub`, 127.0.0.1:3100, basePath `/midhub`),
root helper `bsm-midhub-helper.service` (socket `/run/midhub/helper.sock`, 0660 root:bsmmidhub),
Caddy in front. The installer renders unit templates with the real repo path (`APP_DIR`, default =
the repo root containing `deploy/`; override: `sudo APP_DIR=/path deploy/install.sh` or pass as arg 1).
`install.sh` never touches `bsm-agenthub` or Caddy.

## 1. Build (as bsmmidhub, in APP_DIR)

Deploy from a checkout OWNED BY bsmmidhub, e.g. as bsmmidhub:
`git clone <repo> /home/bsmmidhub/midhub && cd /home/bsmmidhub/midhub` and build there. (The
`mid_workspace` directory is a dev checkout owned by another user; `install.sh` refuses to install if
bsmmidhub cannot read the repo, write `.next`, or execute node/prisma.)

    npm ci --legacy-peer-deps      # or plain `npm ci` if .npmrc carries legacy-peer-deps
    npm run build
    npm run helper:build           # produces helper/dist/helper/main.js
    # migrations are applied by the unit's ExecStartPre; to pre-check: npx prisma migrate deploy

## 2. Create .env.local (APP_DIR/.env.local, mode 600)

systemd's EnvironmentFile does NOT support inline comments: keep comments on their own lines.
The SQLite DB lives outside the repo, in `/opt/midhub/db` (created by install.sh as bsmmidhub 0750;
if you want to run `prisma migrate deploy` before install.sh, create it yourself first).

    cat > .env.local <<ENV
    DATABASE_URL=file:/opt/midhub/db/midhub.db
    JWT_SECRET=$(openssl rand -base64 48)
    ADMIN_EMAIL=you@example.com
    ADMIN_PASSWORD=$(openssl rand -base64 18)
    MIDHUB_VAULT_KEY=$(openssl rand -base64 32)
    MIDHUB_ROOT=/opt/midhub
    MIDHUB_MAX_RUNNING=4
    PUBLIC_URL=https://10.4.150.142
    ENV
    chmod 600 .env.local

An absolute `file:` path resolves identically for the app and for `prisma migrate`. `JWT_SECRET` must
be >= 32 chars; `MIDHUB_VAULT_KEY` is base64 of exactly 32 bytes (losing it makes stored instance
passwords unrecoverable - back it up). `PUBLIC_URL` (a single value, scheme+host, no path) decides the
host used in OIDC redirect URIs, so SSO works only when users reach MidHub via that hostname.

## 3. Install units (root)

    sudo deploy/install.sh

Aborts if `fs.protected_hardlinks != 1`, `/usr/bin/unzip`, `/usr/bin/zipinfo` or `/usr/bin/tar` is missing (Phase 2 jobs need them), or the helper build / `.next` / `.env.local` is missing.
Creates group `midhub`, system user `midsvc`, adds `bsmmidhub` to `midhub`, `/opt/midhub/{mids,packages,archive,db,jobs}` (`jobs` = install/clone/uninstall journals, bsmmidhub 0750),
copies the helper build (`helper/dist`, regular `.js` files only) to `/usr/local/lib/midhub-helper` owned by
root:root (dirs 0755, files 0644) - the root helper unit runs ONLY that copy, never the app-writable checkout -
installs both units, `daemon-reload`, `enable --now`. If a unit file or the helper copy changed, or `bsmmidhub`
was newly added to `midhub`, it runs `systemctl try-restart` on both services.

The web app unit can write only `APP_DIR/.next` and `/opt/midhub` (`ReadWritePaths`); the rest of the
checkout is read-only to the running app.

Note: the `phase2_jobs` migration redefines the `Job` table and needs it empty (Phase 1 never wrote jobs); a dev DB with job rows must be reset.

## 4. Caddy

Back up and edit `/etc/caddy/Caddyfile` by hand. Add the `@midhub path /midhub /midhub/*` + `handle @midhub` block from
`deploy/Caddyfile.midhub` to BOTH AgentHub site blocks (`/midhub` itself is the canonical URL, so the
matcher lists both). Because AgentHub's sites use a site-level `reverse_proxy`, the `handle` blocks take
precedence for /midhub; AgentHub's own traffic is unchanged.

Body limits are enforced by Caddy before the app sees (and authenticates) a request: only the upload
endpoint `^/midhub/api/mids/<name>/files$` may send up to 51 MiB; everything else under /midhub is capped at
1 MiB (config files are edited as JSON, so a config file close to the app's 1 MB save limit can hit this cap
first - real config.xml files are far smaller). Sizes are written in MiB on purpose: Caddy reads `MB` as
10^6 bytes. The app itself accepts one upload at a time and runs with `MemoryMax=1G`.

Upload limit, two options:

- (b) DEFAULT: leave AgentHub untouched. Its site-level `request_body { max_size 50MB }` (10^6 bytes) runs
  before `handle`, so the effective MidHub upload limit is about 47.6 MiB (Caddy returns 413 for larger
  bodies). The UI says "ไม่เกิน 50 MB".
- (a) OPTIONAL, to allow a full 50 MiB file: wrap AgentHub's proxying in a trailing `handle { }`
  (back up first, then `caddy validate`):

        https://10.4.150.142 {
            tls internal
            @midhub path /midhub /midhub/*
            handle @midhub {
                @midhubUpload path_regexp ^/midhub/api/mids/[^/]+/files$
                @midhubOther not path_regexp ^/midhub/api/mids/[^/]+/files$
                request_body @midhubUpload {
                    max_size 51MiB
                }
                request_body @midhubOther {
                    max_size 1MiB
                }
                reverse_proxy 127.0.0.1:3100 {
                    header_up X-Forwarded-For {client_ip}
                    flush_interval -1
                }
            }
            handle {
                reverse_proxy 127.0.0.1:3000 {
                    header_up X-Forwarded-For {client_ip}
                }
                request_body {
                    max_size 50MB
                }
            }
            encode gzip
            log
        }

Then:

    caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy

`flush_interval -1` keeps the live log tail (SSE) unbuffered.

## 5. Verify

- `systemctl is-active bsm-midhub bsm-midhub-helper` -> `active active`
- `https://<host>/midhub` shows the login page
- AgentHub still works at `/`; its `session` cookie does not log you into MidHub (cookie is `midhub_session`, Path=/midhub)
- Log in as admin; import `spike1`; Stop -> Start -> Restart work
- Starting a 5th MID is refused
- Config edit + rollback works
- Upload into `agent/extlib` works; into `agent/bin` is refused
- Log tab streams. Also check SSE through Caddy (with `encode gzip` in the site, events must arrive
  incrementally, not in one burst at the end):
  `curl -sN -H "Cookie: midhub_session=<token>" "https://<host>/midhub/api/mids/<name>/logs?file=main"`
  (`file=wrapper` for the wrapper log; take `<token>` from the browser's `midhub_session` cookie); lines
  should appear as the log grows.
- `journalctl -u bsm-midhub -u bsm-midhub-helper -n 50` is clean

### Locked out?

Three wrong passwords lock an account for 15 minutes (SSO is refused while locked, too); it then unlocks by
itself, or an admin can unlock it under Admin -> ผู้ใช้. Break-glass when the only admin is locked out:
`sudo systemctl restart bsm-midhub` - on boot the app clears the lock on `ADMIN_EMAIL` (its password is never
overwritten).

## 6. SSO (optional)

Add the redirect URI (`<PUBLIC_URL>/midhub/api/auth/oidc/callback`) in the IdP; configure it at `/midhub/admin/idp`; add a team member email under users;
verify SSO login. An email not in the user table must get the message "ยังไม่ได้รับสิทธิ์".

## 7. Updating

    git pull && npm ci --legacy-peer-deps && npm run build && npm run helper:build
    sudo deploy/install.sh        # re-copies the helper build to /usr/local/lib/midhub-helper (root-owned)
    sudo systemctl restart bsm-midhub
Always re-run `install.sh` after `npm run helper:build`: restarting `bsm-midhub-helper` alone keeps running the
old root-owned copy (on purpose - the helper never runs code from the app checkout). `install.sh` restarts the
helper itself when the copy changed. Restarting the helper does not stop running MIDs (they are their own units).

## 8. Rollback / uninstall

    sudo systemctl disable --now bsm-midhub bsm-midhub-helper
    sudo rm /etc/systemd/system/bsm-midhub.service /etc/systemd/system/bsm-midhub-helper.service
    sudo rm -rf /usr/local/lib/midhub-helper
    sudo systemctl daemon-reload
    # remove the handle /midhub/* block from /etc/caddy/Caddyfile (restore backup), validate, reload caddy
    # MID units: sudo systemctl disable --now 'midhub-mid-*' ; rm /etc/systemd/system/midhub-mid-*.service
    # Data (only if intended): /opt/midhub, the SQLite DB, then `userdel midsvc; groupdel midhub`

`deploy/midhub-mid.service.example` shows what the helper generates per MID (values confirmed by the Phase 0 spike, see
`docs/spike-mid-linux.md`).

Heap changes rewrite the unit: saving a new RAM (heap) value in the config tab makes the helper regenerate
`/etc/systemd/system/midhub-mid-<name>.service` from MidHub's template (`helper/unit-template.ts`). A unit you
hand-edited on the host (e.g. during the spike) is overwritten - port such edits into the template first.
