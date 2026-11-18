# MidHub Release (AgentHub look, pipeline, go-live) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MidHub looks like BSM AgentHub with the name "BSM MIDHub", ships with the same build/deploy/go-live scripts as AgentHub, and runs for real on the AgentHub host at `https://dev-agenthub.mfec.co.th/midhub` (and `https://10.4.150.142/midhub`).

**Architecture:** Copy AgentHub's design tokens and chrome (not its features) into MidHub; add `scripts/build.sh`, `scripts/deploy.sh`, `deploy/golive-gates.sh` modelled on AgentHub's; deploy from a `bsmmidhub`-owned checkout cloned from the dev repo; insert the MidHub Caddy block into both AgentHub sites with a backup and `caddy validate` before a graceful reload.

**Tech Stack:** Existing stack; Caddy; systemd; bash.

**Spec:** `docs/superpowers/specs/2026-11-18-midhub-design.md` §5 (look), §9 (deploy + pipeline); `docs/superpowers/specs/2026-11-18-midhub-agenthub-integration-design.md` §8. Reference app: `/home/bsmagenthub/ai_workspace` (read-only): `DESIGN.md`, `app/globals.css`, `app/layout.tsx`, `components/AppChrome.tsx`, `components/NavLinks.tsx`, `components/ProfileMenu.tsx`, `scripts/build.sh`, `scripts/deploy.sh`, `deploy/golive-gates.sh`.

## Global Constraints

- Product name in UI, `<title>`, login page and metadata: **"BSM MIDHub"**. Same tokens as AgentHub `DESIGN.md`: brand navy `#002A6D`, brand sky `#1393DF`, accent `#2F5FA6`, ground `#F6F8FB`, the blue/gray palette overrides, Inter + Noto Sans Thai stack, radii (6/8/10/12/16/pill), `btn-primary` gradient, dark mode. No festival themes, no mascot.
- UI copy stays Thai (spec §5 ruling); only layout/visual language changes.
- Never modify the AgentHub repo or restart `bsm-agenthub`. The only shared file touched is `/etc/caddy/Caddyfile`: back it up to `/etc/caddy/Caddyfile.bak-<timestamp>` first, `caddy validate --config` the new file, then `systemctl reload caddy` (graceful). If validate fails, restore the backup and stop.
- Production checkout: `/home/bsmmidhub/midhub`, owned by `bsmmidhub`, `git clone /home/bsmmidhub/mid_workspace` (origin = the dev repo path); deploy = `git pull --ff-only` there.
- Production env (`/home/bsmmidhub/midhub/.env.local`, mode 0600, owner bsmmidhub): `DATABASE_URL=file:/opt/midhub/db/midhub.db`, fresh `JWT_SECRET` (`openssl rand -base64 48`), `MIDHUB_VAULT_KEY` (`openssl rand -base64 32`), `ADMIN_EMAIL=kasira_c@mfec.co.th`, generated `ADMIN_PASSWORD` (24 chars, shown once to the user at the end), `MIDHUB_ROOT=/opt/midhub`, `MIDHUB_MAX_RUNNING=4`, `PUBLIC_URL=https://dev-agenthub.mfec.co.th`, `MIDHUB_AGENT_SECRET` (`openssl rand -base64 48`, also recorded for the AgentHub patch, never committed).
- Every gate in `deploy/golive-gates.sh` prints PASS/FAIL/MANUAL like AgentHub's and exits 1 on any FAIL.

## Review Focus

1. A Caddy edit that breaks AgentHub → validate before reload, restore on failure; gate checks AgentHub still answers on `/`. Task 4.
2. `/midhub` (no trailing slash) and `/midhub/` both reach MidHub on both sites. Task 4 gate.
3. `/midhub/api/agent/*` is not reachable from outside (404 at Caddy). Task 4 gate.
4. Deploy re-run is idempotent (second `scripts/deploy.sh` run changes nothing and services stay active). Task 3.
5. Dark mode and 390 px mobile still have no horizontal overflow after the restyle. Task 1 Playwright.

---

### Task 1: AgentHub look, "BSM MIDHub" brand

**Files:**
- Modify: `app/globals.css`, `app/layout.tsx`, `app/login/page.tsx` + `components/LoginForm.tsx`, `components/TopBar.tsx`, `components/AdminNav.tsx`, `app/admin/layout.tsx`, buttons/inputs across `components/*.tsx` to use the shared classes
- Create: `components/AppChrome.tsx` (header modelled on AgentHub's: brand mark + "BSM MIDHub", nav tabs Dashboard / Admin with AgentHub's active underline, profile menu with email + logout), `public/` logo asset (re-use AgentHub's mark with the text changed; SVG)
- Test: existing suite; Playwright screenshots

**Interfaces:**
- Produces: CSS tokens and utility classes identical in name and value to AgentHub's `app/globals.css` sections for palette, type, radius, `btn-primary`/secondary buttons, focus ring, dark mode; `AppChrome` used by the dashboard and admin layouts; theme preference (light/dark/system) stored like AgentHub's.

- [ ] **Step 1:** Port tokens and base styles from AgentHub `app/globals.css` (skip festival theme imports), fonts from `app/layout.tsx`.
- [ ] **Step 2:** Build `AppChrome`; replace the current top bar header row with it (quota/RAM/disk chips and the create/import buttons move into the dashboard toolbar below the chrome).
- [ ] **Step 3:** Restyle login page like AgentHub's login (brand, card, SSO button style), with "BSM MIDHub".
- [ ] **Step 4:** Full suite, tsc, eslint; Playwright (scratchpad, DB copy, temp MIDHUB_ROOT): login, dashboard with a MID selected, each tab, admin pages — light and dark, 1280 and 390 px; assert `scrollWidth <= innerWidth`; save screenshots to the scratchpad `shots/release/`.
- [ ] **Step 5:** Commit `feat(ui): AgentHub design system, BSM MIDHub branding`.

---

### Task 2: Build, deploy and go-live scripts

**Files:**
- Create: `scripts/build.sh` (`next build` + `npm run helper:build`), `scripts/deploy.sh`, `deploy/golive-gates.sh`
- Modify: `package.json` (`"build": "bash scripts/build.sh"`), `deploy/README.md`

**Interfaces:**
- `scripts/deploy.sh` (run as root or with sudo; `APP_DIR` default `/home/bsmmidhub/midhub`, `APP_USER` default `bsmmidhub`), idempotent: `git pull --ff-only` (as APP_USER) → `npm ci` (as APP_USER) → `npm run build` (as APP_USER) → `npx prisma migrate deploy` (as APP_USER) → `deploy/install.sh` (copies helper to the root-owned location, renders units, restarts only when changed) → `systemctl restart bsm-midhub` → status head. Never touches AgentHub or Caddy.
- `deploy/golive-gates.sh` gates: services `bsm-midhub` and `bsm-midhub-helper` active; socket `/run/midhub/helper.sock` is `root:bsmmidhub 0660`; helper code dir root-owned and not group/world-writable; `fs.protected_hardlinks=1`; SQLite `journal_mode=wal` on the prod DB; `node -e "require('better-sqlite3')"` under the service Node; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/midhub/login` = 200; via Caddy on both sites `/midhub` and `/midhub/login` = 200/308→200 and `/midhub/api/agent/mids` = 404; AgentHub `/` still 200/307; `.env.local` mode 0600; MANUAL: SSO redirect URI registered, admin password rotated.

- [ ] **Step 1:** Write the scripts mirroring AgentHub's structure and comments; `bash -n` all three.
- [ ] **Step 2:** Commit `chore(deploy): build/deploy/go-live scripts like AgentHub`.

---

### Task 3: First production deploy

- [ ] **Step 1:** `sudo -u bsmmidhub git clone /home/bsmmidhub/mid_workspace /home/bsmmidhub/midhub`; write `.env.local` per Global Constraints (secrets generated on the host, never printed except the admin password at the very end); `sudo deploy/install.sh` from the checkout (creates dirs, users already exist from the spike).
- [ ] **Step 2:** `sudo scripts/deploy.sh` → services active; run it a second time → no changes, still active (Review Focus 4).
- [ ] **Step 3:** Import the spike MID: log in as admin via `http://127.0.0.1:3100/midhub` (curl with cookie jar) and `POST /api/mids/import {"name":"spike1"}` → 200; dashboard lists `spike1` running.

---

### Task 4: Caddy and go-live gates

- [ ] **Step 1:** Back up `/etc/caddy/Caddyfile`; insert the MidHub snippet (agent-API 404 block + `@midhub` handle) at the top of **both** AgentHub site blocks (`https://10.4.150.142` and `http://dev-agenthub.mfec.co.th`), keeping AgentHub's own directives unchanged (upload option (b): AgentHub's site-level 50MB `request_body` stays); `caddy validate --config <new>`; install it; `systemctl reload caddy`. On any failure restore the backup and reload.
- [ ] **Step 2:** `sudo deploy/golive-gates.sh` → no FAIL. Fix and re-run until clean.
- [ ] **Step 3:** Playwright against `https://10.4.150.142/midhub` (ignore the internal-CA cert): login as admin, see `spike1`, open each tab; screenshot to scratchpad `shots/golive/`.
- [ ] **Step 4:** Commit any script fixes `fix(deploy): go-live adjustments`.
