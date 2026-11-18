# MidHub deployment runbook

Layout on the host: web app `bsm-midhub.service` (user `bsmmidhub`, 127.0.0.1:3100, basePath `/midhub`),
root helper `bsm-midhub-helper.service` (socket `/run/midhub/helper.sock`, 0660 root:bsmmidhub),
Caddy in front. The installer renders unit templates with the real repo path (`APP_DIR`, default =
the repo root containing `deploy/`; override: `sudo APP_DIR=/path deploy/install.sh` or pass as arg 1).
`install.sh` never touches `bsm-agenthub` or Caddy.

## 1. Build (as bsmmidhub, in APP_DIR)

    npm ci --legacy-peer-deps      # or plain `npm ci` if .npmrc carries legacy-peer-deps
    npm run build
    npm run helper:build           # produces helper/dist/helper/main.js
    # migrations are applied by the unit's ExecStartPre; to pre-check: npx prisma migrate deploy

## 2. Create .env.local (APP_DIR/.env.local, mode 600)

    cat > .env.local <<ENV
    DATABASE_URL=file:/home/bsmmidhub/mid_workspace/data/midhub.db   # absolute path, writable by bsmmidhub
    JWT_SECRET=$(openssl rand -base64 48)
    ADMIN_EMAIL=you@example.com
    ADMIN_PASSWORD=$(openssl rand -base64 18)
    MIDHUB_VAULT_KEY=$(openssl rand -base64 32)
    MIDHUB_ROOT=/opt/midhub
    MIDHUB_MAX_RUNNING=4
    PUBLIC_URL=https://10.4.150.142
    ENV
    chmod 600 .env.local; mkdir -p data

`JWT_SECRET` must be >= 32 chars; `MIDHUB_VAULT_KEY` is base64 of exactly 32 bytes (losing it makes
stored instance passwords unrecoverable - back it up). `PUBLIC_URL` (scheme+host, no path) is used for
OIDC redirect URIs behind the proxy. See `.env.local.example`. Check `DATABASE_URL` against how
`prisma.config.ts` / `lib/env.ts` resolve relative paths; an absolute path is safest.

## 3. Install units (root)

    sudo deploy/install.sh

Aborts if `fs.protected_hardlinks != 1`, or the helper build / `.next` / `.env.local` is missing.
Creates group `midhub`, system user `midsvc`, adds `bsmmidhub` to `midhub`, `/opt/midhub/{mids,packages,archive}`,
installs both units, `daemon-reload`, `enable --now`. If `bsmmidhub` was newly added to `midhub`,
`sudo systemctl restart bsm-midhub`.

## 4. Caddy

Edit `/etc/caddy/Caddyfile` by hand (back it up first). Add the `handle /midhub/*` block from
`deploy/Caddyfile.midhub` to BOTH AgentHub site blocks, before AgentHub's own proxying. Because
AgentHub's sites use site-level `reverse_proxy` and `request_body { max_size 50MB }`, and Caddy applies
a site-level `request_body` before `handle`, wrap those in a trailing `handle { }`:

    https://10.4.150.142 {
        tls internal
        handle /midhub/* {
            request_body { max_size 51MB }
            reverse_proxy 127.0.0.1:3100 {
                header_up X-Forwarded-For {client_ip}
                flush_interval -1
            }
        }
        handle {
            reverse_proxy 127.0.0.1:3000 { header_up X-Forwarded-For {client_ip} }
            request_body { max_size 50MB }
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
- Log tab streams
- `journalctl -u bsm-midhub -u bsm-midhub-helper -n 50` is clean

## 6. SSO (optional)

Add the redirect URI (`<PUBLIC_URL>/midhub/api/auth/oidc/callback` - confirm the exact path in
`lib/auth/oidc.ts`) in the IdP; configure it at `/midhub/admin/idp`; add a team member email under users;
verify SSO login. An email not in the user table must get the message "ยังไม่ได้รับสิทธิ์".

## 7. Updating

    git pull && npm ci --legacy-peer-deps && npm run build && npm run helper:build
    sudo systemctl restart bsm-midhub bsm-midhub-helper
Restarting the helper does not stop running MIDs (they are their own units).

## 8. Rollback / uninstall

    sudo systemctl disable --now bsm-midhub bsm-midhub-helper
    sudo rm /etc/systemd/system/bsm-midhub.service /etc/systemd/system/bsm-midhub-helper.service
    sudo systemctl daemon-reload
    # remove the handle /midhub/* block from /etc/caddy/Caddyfile (restore backup), validate, reload caddy
    # MID units: sudo systemctl disable --now 'midhub-mid-*' ; rm /etc/systemd/system/midhub-mid-*.service
    # Data (only if intended): /opt/midhub, the SQLite DB, then `userdel midsvc; groupdel midhub`

`deploy/midhub-mid.service.example` shows what the helper generates per MID (ExecStart PROVISIONAL, see
`docs/spike-mid-linux.md`).
