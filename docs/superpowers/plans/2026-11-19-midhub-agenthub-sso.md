# MidHub sign-in with AgentHub (admins only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only AgentHub admins can use MidHub, signed in through their existing AgentHub session; MidHub has no local login.

**Architecture:** A server-side lookup (`lib/auth/agenthub.ts`) asks AgentHub's `/api/auth/me` over loopback with the browser's AgentHub `session` cookie; admins get a MidHub session (`ahAt` claim) that `proxy.ts` re-verifies every 5 minutes. Local password/OIDC login, password reset and user management are removed; the agent API requires `X-MidHub-Actor-Role: admin`.

**Tech Stack:** Existing (Next.js 16, jose, Prisma/SQLite, Vitest).

**Spec:** `docs/superpowers/specs/2026-11-19-midhub-agenthub-sso-design.md`

## Global Constraints

- `AGENTHUB_URL` default `http://127.0.0.1:3000`; reject (env validation error) anything not `http://127.0.0.1:<port>`, `http://localhost:<port>` or `http://[::1]:<port>`.
- Lookup: `GET ${AGENTHUB_URL}/api/auth/me`, header `Cookie: session=<value>` only (no other browser headers), `redirect: "manual"`, timeout 5 s. 200 with `role === "admin"` and a valid email → admin; 200 non-admin → `not_admin`; 401/403 → `signed_out`; anything else / network error / timeout → `unreachable`.
- The AgentHub cookie value never appears in logs, audit, errors or responses.
- Re-verify when `now - ahAt > 300 s`; failure → clear `midhub_session`, API → 401 `{code:"unauthenticated"}`, pages → redirect to `/login?reason=<signed_out|not_admin|unreachable|locked>`.
- MidHub `User.isLocked` still denies (reason `locked`) even when AgentHub says admin.
- Agent API: `X-MidHub-Actor-Role` must equal `admin` (case-sensitive) → else 403 `agent_user` with message "ต้องเป็น admin ของ AgentHub (บัญชี <email>)"; the actor is upserted as admin; a locked MidHub user is still refused.
- Audit `auth.login` `{ via: "agenthub" }` on each new MidHub session; `auth.denied` `{ reason }` (no cookie) at most once per reason per 10 min per email/IP to avoid floods.
- Thai copy, AgentHub look (existing classes), `{ code, message, detail? }` errors.

## Review Focus

1. A request carrying a valid MidHub session whose AgentHub admin was demoted → refused within 5 minutes (next request after the window).
2. AgentHub down → access page says AgentHub unreachable; no 500, no redirect loop between `/midhub` and `/midhub/login`.
3. No path left that creates a session without AgentHub (old login POST, OIDC callback, password reset all 404/removed).
4. The forwarded cookie can't be steered: `AGENTHUB_URL` non-loopback refused; redirects from AgentHub not followed.
5. Agent API: an AgentHub admin who never opened MidHub works; `X-MidHub-Actor-Role: user` → 403.

---

### Task 1: AgentHub sign-in, re-verification, removal of local login

**Files:**
- Create: `lib/auth/agenthub.ts`, `app/api/auth/agenthub/route.ts` (GET: does the lookup, sets the MidHub session, redirects to `next`), tests next to them
- Modify: `lib/env.ts` (drop ADMIN_EMAIL/ADMIN_PASSWORD requirement; add `agenthubUrl`), `lib/auth/jwt.ts` (`ahAt` claim), `proxy.ts` (no session → try AgentHub sign-in; stale `ahAt` → re-verify), `app/login/*` (access page), `lib/db/seed.ts` / `instrumentation.ts` (no admin seeding), admin nav + users page (read-only list with lock/unlock), audit labels
- Remove: `app/api/auth/login`, `app/api/auth/oidc/*`, `app/api/auth/idp`, `app/api/admin/idp`, `app/admin/idp`, password reset/user create/role routes + UI (`components/IdpConfigManager.tsx`, `components/LoginForm.tsx`, user create/edit parts of `components/UsersManager.tsx`), their tests; `.env.local.example`, `deploy/README.md` updated
- Test: lookup outcomes table (fake AgentHub server on a random loopback port); proxy re-verify after 300 s; demoted admin refused; locked user refused; unreachable → access page, no loop; removed routes 404; env rejects non-loopback `AGENTHUB_URL`

**Interfaces:**
- Produces: `type AgentHubLookup = { ok: true; email: string } | { ok: false; reason: "signed_out" | "not_admin" | "unreachable" }`; `lookupAgentHubAdmin(sessionCookie: string | undefined): Promise<AgentHubLookup>`; `signInFromAgentHub(email: string): Promise<SessionPayload>` (upsert admin user, lock check → throws `MidError("account_locked")`); `SessionPayload.ahAt: number` (epoch seconds).

- [ ] Step 1: failing tests. Step 2: run → FAIL. Step 3: implement. Step 4: full suite, tsc, eslint, build. Step 5: commit `feat(auth): sign in with AgentHub (admins only); remove local login`.

### Task 2: Agent API actor role

**Files:**
- Modify: `lib/agent/auth.ts` (require `X-MidHub-Actor-Role: admin`; upsert via `signInFromAgentHub`-style helper without a session), `lib/agent/checks.ts` (`user_registered` message), `docs/agent-api.md`, `docs/superpowers/plans/2026-11-18-agenthub-midhub-patch.md` (Global Constraints + Task 3 headers: send `X-MidHub-Actor-Role` from AgentHub's `User.role` at request time)
- Test: `lib/agent/auth.test.ts` additions per Global Constraints

- [ ] Step 1: failing tests. Step 2: run → FAIL. Step 3: implement. Step 4: full suite. Step 5: commit `feat(agent): actor must be an AgentHub admin`.
