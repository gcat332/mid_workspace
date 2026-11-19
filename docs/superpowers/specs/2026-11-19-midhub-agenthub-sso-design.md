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
- **Admins only.** `role === "admin"` → MidHub upserts `User{ email (lowercased), role: "admin" }` and issues
  its own `midhub_session` (existing JWT/cookie, path `/midhub`). Any other role or 401 → the access page.
- **Re-verification.** The MidHub session carries `ahAt` (time AgentHub last confirmed). Requests with a session
  older than 5 minutes since `ahAt` re-ask AgentHub; not admin / 401 / AgentHub unreachable → session cleared
  (fail closed: option ข. accepts that MidHub is unusable while AgentHub is down). Logout from MidHub clears
  only MidHub's cookie.
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
