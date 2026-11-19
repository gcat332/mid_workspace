# MidHub — sign in with AgentHub (admins only)

Date: 2026-11-19 · Status: approved by the user (option ข.: no MidHub-local login at all)

## Intent

MidHub and BSM AgentHub run on the same host and the same sites (`https://10.4.150.142`,
`https://dev-agenthub.mfec.co.th`). The user wants one set of users: the people who may use MidHub are
exactly AgentHub's **admins**. MidHub keeps no passwords, no SSO config and no user management of its own.

## Decisions

- **Identity source = AgentHub.** The browser already sends AgentHub's `session` cookie (path `/`) with
  `/midhub/*` requests (same host). MidHub never verifies AgentHub's JWT itself and never holds AgentHub's
  secret. It asks AgentHub over loopback: `GET http://127.0.0.1:3000/api/auth/me` with only
  `Cookie: session=<value>` → `200 { email, role }` or `401`. Base URL from `AGENTHUB_URL`
  (default `http://127.0.0.1:3000`); must be a loopback http URL.
- **Listener owner check (anti port squatting; final review Important 1).** Port 3000 is unprivileged: while
  AgentHub is down any local account could listen on it, answer "admin" for any email and collect the
  forwarded `session` cookies. Before every lookup MidHub reads `/proc/net/tcp` and `/proc/net/tcp6`
  (world-readable) and finds the LISTEN sockets on the URL's port whose local address is the URL's loopback
  address or a wildcard (`0.0.0.0`, `::`, v4-mapped forms included; `localhost` = both families). There must be
  at least one, and every one must be owned by `AGENTHUB_SERVICE_USER` (default `bsmagenthub`; uid from
  `/etc/passwd`, cached per process). Otherwise the lookup is `unreachable` (warn log "listener on :<port> not
  owned by <user>", no cookie) and nothing is sent. A user missing from `/etc/passwd` is a configuration error
  (500 + log, also logged at boot), not "unreachable". Only `AGENTHUB_SERVICE_USER=none` disables the check
  (dev/tests). Residual: a race in the milliseconds between the check and the connect if AgentHub dies exactly
  then; closing it fully needs a unix socket or peer credentials, out of scope. The reverse direction
  (AgentHub → MidHub :3100 with `MIDHUB_AGENT_SECRET`) has the same pre-existing exposure; not addressed here.
- **Admins only.** `role === "admin"` → MidHub upserts `User{ email (lowercased), role: "admin" }` and issues
  its own `midhub_session` (existing JWT/cookie, path `/midhub`). Any other role or 401 → the access page.
- **Re-verification.** The MidHub session carries `ahAt` (time AgentHub last confirmed). Requests with a session
  older than 5 minutes since `ahAt` re-ask AgentHub; not admin / 401 / AgentHub unreachable → session cleared
  (fail closed: option ข. accepts that MidHub is unusable while AgentHub is down). Logout from MidHub clears
  only MidHub's cookie.
  **Limitation until the AgentHub patch plan's Task 0 is applied:** AgentHub's `/api/auth/me` currently returns the role
  stored in its sliding session JWT, not the DB. A demoted (or deleted/locked) AgentHub admin therefore keeps MidHub
  access until their AgentHub session ends (up to 4 h idle, indefinitely while they keep using AgentHub). To cut access
  immediately, also lock them on MidHub's Users page. Once Task 0 is in, the 5-minute re-check is effective. An admin
  who works only in MidHub must use AgentHub at least every 4 h (MidHub's checks do not extend AgentHub's session),
  otherwise MidHub asks them to sign in again.
- **No local login (option ข.).** Removed: password login, MidHub OIDC/IdP login and its admin page, password
  reset, user create/edit/role management UI and APIs, ADMIN_EMAIL/ADMIN_PASSWORD seeding and env requirement.
  Kept: Users page becomes read-only (who has signed in, last seen, lock/unlock), lockout of a MidHub user
  still denies access even if AgentHub says admin, audit, IP allowlist.
- **Access page** (`/midhub/login`, Thai, AgentHub look): states why (not signed in to AgentHub / not an admin /
  AgentHub unreachable) and links to AgentHub's `/login` on the same site.
- **AgentHub API actor (server-to-server).** AgentHub additionally sends `X-MidHub-Actor-Role` (the actor's
  AgentHub role, from its DB at request time). MidHub requires `admin`; it upserts the user as on browser
  sign-in, so an AgentHub admin works before ever opening MidHub. Non-admin → 403 `agent_user`
  (`user_registered` message updated: "ต้องเป็น admin ของ AgentHub"). AgentHub patch plan and
  `docs/agent-api.md` updated accordingly.
- **Secrets.** The forwarded cookie value is never logged, audited or echoed. Audit `auth.login` with
  `{ via: "agenthub" }`.

## Non-goals

No change to the AgentHub repo by MidHub's developers (the `X-MidHub-Actor-Role` header is added to the
AgentHub patch plan the user applies). No MidHub-side SSO. No per-user roles inside MidHub (everyone is admin).

## Known constraint (outside MidHub)

The corporate reverse proxy currently sends `dev-agenthub.mfec.co.th` straight to `10.4.150.142:3000`
(AgentHub's Next server), bypassing Caddy, so `/midhub` is unreachable on that domain until the network
team points it at `10.4.150.142:80` (Caddy already serves that site and trusts the proxy's XFF).
