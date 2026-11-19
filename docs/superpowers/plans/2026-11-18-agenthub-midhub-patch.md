# AgentHub → MidHub Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan targets the AgentHub repository** (`/home/bsmagenthub/ai_workspace`, origin `github.com/gcat332/ai-workspace`). It lives in the MidHub repo so it travels with the design. Follow AgentHub's own `CLAUDE.md`, `DESIGN.md` and test conventions; English system copy per AgentHub's DESIGN rules.

**Goal:** น้อง Java in an AgentHub session can call MidHub (list MIDs with a checklist, edit files, read logs, restart) through an AgentHub route that proves who the user is and which ServiceNow instances the session works with — without Java ever seeing the server-to-server secret.

**Architecture:** A new per-run, task-scoped bearer token family (`AGENT_MIDHUB_TOKEN`, modelled on `lib/auth/subtask-token.ts`) is injected into the run env next to `AGENT_TASK_TOKEN`. Java curls `ALL /api/tasks/<taskId>/midhub/<path>`; the route verifies the token, resolves the actor and the session's instance set server-side, and streams the request to MidHub over loopback with `X-MidHub-*` headers. A short doc appended to the run prompt teaches Java the calls.

**Tech Stack:** AgentHub's stack (Next.js 16, jose, Prisma/SQLite, Vitest).

**Spec:** `docs/superpowers/specs/2026-11-18-midhub-agenthub-integration-design.md` in the MidHub repo (§5, §5.1–5.1.3, §5.4, §8). MidHub API reference: `docs/agent-api.md` in the MidHub repo.

## Global Constraints

- Feature is on only when both `MIDHUB_URL` (e.g. `http://127.0.0.1:3100/midhub`) and `MIDHUB_AGENT_SECRET` (≥ 32 chars, same value as MidHub's) are set in AgentHub's server env. Off → no token minted, no prompt doc, route returns 404.
- `MIDHUB_AGENT_SECRET` and `MIDHUB_URL` must **never** enter `agentEnv()`, the run env, a prompt, a journal or a log line.
- Token: issuer `ai-workspace/midhub-proxy`, claims `{ taskId, actorUserId, purpose: "midhub-proxy" }`, HS256 with AgentHub's JWT secret, TTL 4 h; must be rejected by `verifyToken` (session) and `verifySubtaskToken`, and vice versa — same two-way separation as the subtask token.
- Headers sent to MidHub: `X-MidHub-Agent-Secret`, `X-MidHub-Actor-Email` (lowercase), `X-MidHub-Session-Id` (= taskId, or the parent taskId for a sub-task), `X-MidHub-Session-Instances` (comma-joined, may be empty). Do **not** send `X-Forwarded-For` (MidHub rejects requests that have it).
- `X-MidHub-Session-Id` is required and must be non-empty (printable, <= 128 chars); MidHub returns 400 `agent_auth` otherwise. The request must go to `http://127.0.0.1:3100/midhub` (`MIDHUB_URL`) so the `Host` header is loopback: MidHub returns 403 `agent_auth` for any other Host (e.g. a public hostname or IP), as well as for any non-loopback `X-Forwarded-For`/`X-Real-IP`/`Forwarded`.
- Session instance set = normalise to `https://<x>.service-now.com/` and dedupe, from: `Task.instanceHost`; `SN_INSTANCE_URL` in `<sessionDir>/.env`; `SN_INSTANCE_URL` in every `<sessionDir>/snow-projects/*/.env`. A sub-task uses its **parent** session's set and actor. Values that are not `*.service-now.com` are dropped.
- Actor = the user whose message started the run; recovery or unknown → the task owner (`Task.userId`). Actor must still own or participate in the task at request time.
- Forwarded path allowlist (relative to `/api/tasks/<id>/midhub/`): `mids`, `mids/<name>/files`, `mids/<name>/logs`, `mids/<name>/restart`, with `<name>` matching `^[a-z0-9][a-z0-9-]{1,39}$`. Anything else → 404 without contacting MidHub.
- MidHub's browser sign-in depends on AgentHub's `GET /api/auth/me` reflecting the **DB** (Task 0): MidHub signs in only users that `/api/auth/me` reports with `role: "admin"`, and it re-asks every 5 minutes. Today `/api/auth/me` returns the role baked into the sliding session JWT, so a demoted or deleted AgentHub admin keeps MidHub access until their AgentHub session ends. Apply Task 0 first.
- Stream request and response bodies (uploads up to 50 MiB); forward method, query string, `Content-Type`, `Content-Length`; return MidHub's status and body unchanged; 120 s timeout → 504 `{ error: "MidHub did not respond" }`; connection refused → 502 `{ error: "MidHub is not running" }`.

## Review Focus

1. Java edits `.env` mid-session to add another instance → the next call reflects it (set computed per request); that is accepted by design, but the token can never be replayed for another taskId (401). Test in Task 3.
2. A collaborator (not owner) triggers the run → MidHub sees the collaborator's email, not the owner's. Test in Task 2.
3. The secret never appears in the run env or prompt (grep the spawned env and the prompt builder output). Test in Task 2 and Task 4.
4. A 50 MiB upload streams through without buffering the whole body in memory and the declared length reaches MidHub. Test in Task 3.
5. MidHub down → Java gets a clear 502 message rather than a hang. Test in Task 3.

---

### Task 0: `/api/auth/me` reflects the DB

MidHub (sign-in with AgentHub, admins only) asks `GET /api/auth/me` with the browser's `session` cookie and trusts
`role`. It currently returns the JWT's claims (`getSessionUser()` = `verifyToken` only, and the proxy re-mints the
cookie with the old role on every request), so demoting, locking or deleting an admin in AgentHub never reaches MidHub
while that AgentHub session lives.

**Files:**
- Modify: `app/api/auth/me/route.ts`
- Test: `app/api/auth/me/route.test.ts` (new)

**Interfaces:**
- Produces: `GET /api/auth/me` → `200 { email, role }` where `email` and `role` come from the `User` row looked up by the
  JWT's `userId` (the JWT's subject) at request time; `401 { error: "Unauthorized" }` when there is no valid session, the
  user no longer exists, or the user is locked (`lockedAt` set; AgentHub locks last until an admin unlocks). Response shape and
  status codes are otherwise unchanged (MidHub maps 401/403 → signed out, 200 non-admin → not admin).

- [ ] **Step 1: Failing tests** (mock prisma like `lib/auth/helpers.test.ts`): valid JWT with role `admin` but DB role
  `user` → `200 { role: "user" }`; DB email differs in case → DB value returned; user deleted → 401; user locked → 401;
  no cookie / garbage cookie → 401; the response never contains `passwordHash`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement: `const s = await getSessionUser(); if (!s) 401;
  const u = await prisma.user.findUnique({ where: { id: s.userId }, select: { email: true, role: true, lockedAt: true } });
  if (!u || u.lockedAt) 401; return { email: u.email, role: u.role }`. Do not change `getSessionUser()` itself (other
  callers keep their current behaviour). **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `fix(auth): /api/auth/me reports the user's current role from the DB`.

---

### Task 1: Token family

**Files:**
- Create: `lib/auth/midhub-token.ts`, `lib/auth/midhub-proxy-bypass.ts`
- Modify: `proxy.ts` (call the bypass next to `isSubtaskDispatchBypass`)
- Test: `lib/auth/midhub-token.test.ts`, `lib/auth/midhub-proxy-bypass.test.ts`, `proxy.test.ts`

**Interfaces:**
- Produces: `MIDHUB_TOKEN_ISSUER = "ai-workspace/midhub-proxy"`; `signMidhubToken(taskId: string, actorUserId: string): Promise<string>`; `verifyMidhubToken(token: string): Promise<{ taskId: string; actorUserId: string } | null>`; `isMidhubProxyBypass(method: string, pathname: string, authHeader: string | null): boolean` — any method, path `^/api/tasks/[^/]+/midhub(/.*)?$`, Bearer only.

- [ ] **Step 1: Failing tests:** round trip; session JWT and subtask token rejected by `verifyMidhubToken`; a midhub token rejected by `verifyToken` and `verifySubtaskToken`; expired token rejected; bypass true only for the path shape + Bearer.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement mirroring `subtask-token.ts`. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(midhub): task-scoped MidHub proxy token`.

---

### Task 2: Inject the token for the right actor

**Files:**
- Modify: `lib/providers/agent-spawn.ts` (`startRun` opts gain `actorUserId?: string`; when the feature is on, env gets `AGENT_MIDHUB_TOKEN`), every `startRun` caller in `lib/providers/chat-run.ts` (pass the message author's userId) and `lib/db/startup.ts` (recovery: the RunRecord's stored actor if you add one, else `Task.userId`), and any interactive/PTY spawn path that already injects `AGENT_TASK_TOKEN`
- Create: `lib/midhub/config.ts` (`midhubEnabled(): boolean`, `midhubUrl()`, `midhubSecret()` — server-only)
- Test: `lib/providers/agent-spawn.test.ts` additions

**Interfaces:**
- Consumes: `signMidhubToken`.
- Produces: run env contains `AGENT_MIDHUB_TOKEN` iff `midhubEnabled()`; for a sub-task the token's `taskId` is the **sub-task's** id (the route resolves the parent), and `actorUserId` is the actor of the parent run that dispatched it.

- [ ] **Step 1: Failing tests:** feature off → no `AGENT_MIDHUB_TOKEN`; on → token verifies with the run's taskId and the author's userId; collaborator-authored message → collaborator's id; env never contains `MIDHUB_AGENT_SECRET` or `MIDHUB_URL`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(midhub): inject MidHub token into agent runs`.

---

### Task 3: Proxy route

**Files:**
- Create: `lib/midhub/session-instances.ts`, `app/api/tasks/[id]/midhub/[...path]/route.ts`
- Test: `lib/midhub/session-instances.test.ts`, `app/api/tasks/[id]/midhub/[...path]/route.test.ts`

**Interfaces:**
- Produces:
  - `sessionInstances(taskId: string): Promise<string[]>` — resolves the parent for a sub-task, then reads the three sources in Global Constraints with plain `fs` under `sessionDirOf(...)` (no symlink following outside the session dir: `lstat` each `.env`, skip symlinks), parses `SN_INSTANCE_URL=` lines (quotes stripped), normalises, dedupes, sorts.
  - Route handlers for GET/POST/PUT/DELETE: verify bearer with `verifyMidhubToken`; token `taskId` must equal `[id]` → else 401; actor must exist and still have access to the task (owner, participant, or admin) → else 403; path allowlist; build headers; `fetch(midhubUrl + "/api/agent/" + path + search, { method, headers, body: req.body, duplex: "half", signal: AbortSignal.timeout(120_000) })`; return `new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } })`.

- [ ] **Step 1: Failing tests:** `sessionInstances` merges `Task.instanceHost`, root `.env`, two `snow-projects/*/.env`, drops `http://evil.com`, ignores a symlinked `.env`, and a sub-task returns its parent's set; route: token for task A on `/api/tasks/B/midhub/mids` → 401; disallowed path → 404 with no fetch; headers sent to a fake MidHub server include the four `X-MidHub-*` values and no `X-Forwarded-For`; a 50 MiB streamed upload arrives with the same `Content-Length`; MidHub not listening → 502 message; MidHub response status/body passed through.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(midhub): AgentHub → MidHub proxy route`.

---

### Task 4: Prompt doc for Java

**Files:**
- Modify: `lib/providers/pty-manager.ts` (new `buildMidhubDoc(taskId: string): string` next to `buildSubagentDispatchDoc`, appended under the same conditions when `midhubEnabled()`)
- Test: `lib/providers/pty-manager.test.ts` additions

**Interfaces:**
- Produces: doc text (English) with: when to use it (custom app work that needs files on a MID Server); always start with `GET …/midhub/mids` and only use MIDs whose `usable` is true, explaining failed checks to the user using the returned messages; one curl example per endpoint using `$AGENT_MIDHUB_TOKEN` and the literal taskId; limits (no `agent/config.xml`, `agent/conf/wrapper-override.conf`, `agent/bin|lib|jre`; uploads ≤ 50 MiB with `--data-binary @file`; a jar put in `agent/extlib` is deleted on the next MID start unless it is registered in the instance as a MID Server JAR File (`ecc_agent_jar`; ServiceNow's `FileSync:ecc_agent_jar`); restart is subject to the 4-running quota; ask the user before restart).
  - Logs: `GET …/mids/<name>/logs` returns `{ lines: [] }` when the log file does not exist yet (not an error, and not a sign the MID is idle).

- [ ] **Step 1: Failing tests:** doc present only when enabled; contains the taskId literal and `$AGENT_MIDHUB_TOKEN`; never contains the secret or `MIDHUB_URL` value.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite.
- [ ] **Step 5:** Commit `feat(midhub): teach Java the MidHub calls`.

---

### Task 5: Deploy and end-to-end check

**Files:**
- Modify: `.env.local.example`, `deploy/README.md` (generate secret `openssl rand -base64 48`; set the same value in MidHub's `.env.local`; `MIDHUB_URL=http://127.0.0.1:3100/midhub`)

- [ ] **Step 1:** Set both env values on the host (AgentHub and MidHub), restart both services.
- [ ] **Step 2:** In a session whose `.env` has `SN_INSTANCE_URL` of the MID's instance, with the MID's "อนุญาตให้ AgentHub" switch on in MidHub: ask Java to list MIDs → the MID shows `usable: true`; ask Java to put a small jar into `agent/extlib` and restart → MidHub audit shows `agent.file.upload` and `agent.restart` by your email with `via: agenthub`.
- [ ] **Step 3:** In a session for a different instance → the same MID shows `instance_match` failed with the instance names.
- [ ] **Step 4:** Commit `docs(midhub): AgentHub ↔ MidHub setup`.
